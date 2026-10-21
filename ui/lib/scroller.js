// bulleye continuous scroller
// Every chapter of the book is stacked in one long scrolling column, so you can read from
// the first page to the last without ever hitting a chapter edge. Chapters near the screen
// are loaded; far ones are unloaded again to save memory. It speaks the same language
// (methods and events) as foliate-js's paginator so the rest of the app does not care.
import { getVisibleRange, uncollapse } from './paginator.js'

const PX_PER_UNIT_DEFAULT = 0.22   // first guess for how tall a chapter is until it is measured
const MIN_H = 80
const ease = x => 1 - (1 - x) * (1 - x)
const setImp = (el, styles) => { for (const [k, v] of Object.entries(styles)) el.style.setProperty(k, v, 'important') }
const frame = () => new Promise(r => requestAnimationFrame(() => r()))

export class Scroller extends HTMLElement {
    static observedAttributes = ['gap', 'margin', 'max-inline-size']
    #root = this.attachShadow({ mode: 'closed' })
    #sc
    #col
    #secs = []              // one entry per readable chapter, in reading order
    #byIndex = new Map()
    #styles
    #maxInline = 760
    #margin = 36
    #pin = -1               // chapter that must stay loaded (being navigated to)
    #queue = []
    #running = 0
    #destroyed = false
    #anchorRange = null
    #relocTimer = 0
    #lastReloc = 0
    #anim = null
    #pageTarget = null
    #auto = null
    #rpu = PX_PER_UNIT_DEFAULT
    #ro
    #lastW = 0
    #lastH = 0
    #stylesKey = ''
    constructor() {
        super()
        this.#root.innerHTML = `<style>
            :host { display: block; position: relative; overflow: hidden; width: 100%; height: 100%; }
            #sc { position: absolute; inset: 0; overflow-x: hidden; overflow-y: scroll; overscroll-behavior: contain; }
            #col { position: relative; width: 100%; }
            .sec { position: relative; overflow: hidden; width: 100%; }
            .in { position: relative; width: 100%; }
            iframe { display: block; width: 100%; height: 100%; border: 0; overflow: hidden; }
        </style><div id="sc"><div id="col"></div></div>`
        this.#sc = this.#root.getElementById('sc')
        this.#col = this.#root.getElementById('col')
        this.#sc.addEventListener('scroll', () => this.#onScroll(), { passive: true })
        // the reader taking over the wheel or touch cancels glides and keeps auto scroll honest
        this.#sc.addEventListener('wheel', () => this.#cancelGlide(), { passive: true })
        this.#sc.addEventListener('touchstart', () => this.#cancelGlide(), { passive: true })
        this.#ro = new ResizeObserver(() => this.#onResize())
        this.#ro.observe(this.#sc)
    }
    attributeChangedCallback(name, _, value) {
        const n = parseFloat(value)
        if (name === 'max-inline-size' && n > 0) this.#maxInline = n
        else if (name === 'margin' && n >= 0) this.#margin = n
        else return
        if (this.#secs.length) this.#restyleAll()
    }

    // ---------- opening ----------
    open(book) {
        this.book = book
        this.bookDir = book.dir
        this.sections = book.sections
        book.transformTarget?.addEventListener('data', ({ detail }) => {
            if (detail.type !== 'text/css') return
            const w = innerWidth, h = innerHeight
            detail.data = Promise.resolve(detail.data).then(data => data
                .replace(/(?<=[{\s;])-epub-/gi, '')
                .replace(/(\d*\.?\d+)vw/gi, (_, d) => parseFloat(d) * w / 100 + 'px')
                .replace(/(\d*\.?\d+)vh/gi, (_, d) => parseFloat(d) * h / 100 + 'px'))
        })
        this.#secs = []
        for (const [index, s] of book.sections.entries()) {
            if (!s || s.linear === 'no' || !s.load) continue
            const wrap = document.createElement('div'); wrap.className = 'sec'
            const inner = document.createElement('div'); inner.className = 'in'
            wrap.append(inner)
            const sec = { index, wrap, inner, size: s.size > 0 ? s.size : 0, h: 0, known: false, top: 0, loaded: false, loading: null, doc: null, iframe: null, overlayer: null, ro: null, styleEls: null, failed: false }
            this.#secs.push(sec); this.#byIndex.set(index, sec)
            this.#col.append(wrap)
        }
        this.#layout()
    }

    // ---------- geometry ----------
    get scrolled() { return true }
    get size() { return this.#sc.clientHeight }
    get viewSize() { return this.#sc.scrollHeight }
    get start() { return this.#sc.scrollTop }
    get end() { return this.#sc.scrollTop + this.#sc.clientHeight }
    get atStart() { return this.#sc.scrollTop <= 1 }
    get atEnd() { return this.#sc.scrollTop + this.#sc.clientHeight >= this.#sc.scrollHeight - 2 }
    get scroller() { return this.#sc }

    #estimate(sec) { return Math.max(MIN_H, sec.size * this.#rpu) }
    #heightOf(sec) { return sec.known ? sec.h : this.#estimate(sec) }
    // recompute every chapter's box height (measured if known, estimated otherwise)
    #layout() {
        let sh = 0, ss = 0
        for (const s of this.#secs) if (s.known && s.size > 0 && !s.failed && s.h > 0) { sh += s.h; ss += s.size }
        if (ss > 2000) this.#rpu = sh / ss
        let top = 0
        for (const s of this.#secs) {
            s.top = top
            const h = Math.round(this.#heightOf(s)) + this.#margin * 2
            if (s.boxH !== h) { s.boxH = h; s.wrap.style.height = h + 'px' }
            const m = this.#margin
            if (s.inner.style.marginTop !== m + 'px') s.inner.style.marginTop = m + 'px'
            top += h
        }
    }
    #at(y) {   // chapter whose box contains scroll offset y
        const a = this.#secs
        let lo = 0, hi = a.length - 1
        while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (a[mid].top <= y) lo = mid; else hi = mid - 1 }
        return a[lo]
    }
    #padPx() { return Math.round(this.#sc.clientWidth * 0.0526) }

    // ---------- loading ----------
    #load(sec) {
        if (!sec || this.#destroyed) return Promise.resolve()
        if (sec.loaded) return Promise.resolve()
        if (sec.loading) return sec.loading
        sec.loading = new Promise(resolve => this.#queue.push({ sec, resolve })).then(() => {})
        this.#pump()
        return sec.loading
    }
    #pump() {
        while (this.#running < 3 && this.#queue.length) {
            const { sec, resolve } = this.#queue.shift()
            this.#running++
            this.#doLoad(sec).catch(e => console.warn(e)).finally(() => {
                this.#running--; sec.loading = null; resolve(); this.#pump()
            })
        }
    }
    async #doLoad(sec) {
        if (this.#destroyed || sec.loaded) return
        const section = this.sections[sec.index]
        let src
        try { src = await section.load() } catch (e) { console.warn(e); src = null }
        if (this.#destroyed) { section.unload?.(); return }
        if (typeof src !== 'string') {
            sec.failed = true; sec.known = true; sec.h = 60; sec.loaded = true; this.#layout(); return
        }
        const iframe = document.createElement('iframe')
        iframe.setAttribute('sandbox', 'allow-same-origin allow-scripts')
        iframe.setAttribute('scrolling', 'no')
        iframe.setAttribute('part', 'filter')
        iframe.style.height = this.#heightOf(sec) + 'px'
        sec.inner.style.height = this.#heightOf(sec) + 'px'
        sec.inner.append(iframe)
        await new Promise(res => { iframe.addEventListener('load', res, { once: true }); iframe.src = src })
        if (this.#destroyed || !iframe.isConnected) { section.unload?.(); return }
        const doc = iframe.contentDocument
        sec.iframe = iframe; sec.doc = doc; sec.loaded = true
        if (doc.head) {
            const a = doc.createElement('style'); doc.head.prepend(a)
            const b = doc.createElement('style'); doc.head.append(b)
            sec.styleEls = [a, b]
        }
        this.#applyStyles(sec)
        this.#prepDoc(sec)
        this.dispatchEvent(new CustomEvent('load', { detail: { doc, index: sec.index } }))
        this.#applyStyles(sec)
        // measure now, then keep measuring as images and fonts arrive
        this.#measure(sec)
        sec.ro = new ResizeObserver(() => this.#measure(sec))
        sec.ro.observe(doc.body)
        doc.fonts?.ready?.then(() => this.#measure(sec))
        this.dispatchEvent(new CustomEvent('create-overlayer', {
            detail: { doc, index: sec.index, attach: ov => { sec.overlayer = ov; sec.inner.append(ov.element) } },
        }))
    }
    #unload(sec) {
        if (!sec.loaded) return
        sec.ro?.disconnect(); sec.ro = null
        sec.iframe?.remove()
        sec.inner.replaceChildren()
        sec.iframe = null; sec.doc = null; sec.overlayer = null; sec.styleEls = null
        sec.loaded = false
        try { this.sections[sec.index].unload?.() } catch {}
        if (this.#anchorRange && !this.#anchorRange.startContainer.isConnected) this.#anchorRange = null
    }
    // layout rules that make a chapter flow as one column of text
    #prepDoc(sec) {
        const doc = sec.doc
        if (!doc?.documentElement || !doc.body) return
        const pad = this.#padPx()
        setImp(doc.documentElement, {
            'box-sizing': 'border-box', 'padding': `0 ${pad}px`, 'column-width': 'auto',
            'height': 'auto', 'width': 'auto', 'min-height': '0', 'overflow-wrap': 'break-word',
        })
        setImp(doc.body, { 'max-width': `${this.#maxInline}px`, 'margin': 'auto', 'height': 'auto', 'min-height': '0' })
        const maxH = Math.max(200, this.#sc.clientHeight - this.#margin * 2)
        for (const el of doc.body.querySelectorAll('img, svg, video')) {
            const { maxWidth } = doc.defaultView.getComputedStyle(el)
            setImp(el, {
                'max-height': `${maxH}px`,
                'max-width': maxWidth !== 'none' && maxWidth !== '0px' ? maxWidth : '100%',
                'object-fit': 'contain', 'box-sizing': 'border-box',
            })
        }
    }
    #applyStyles(sec) {
        const st = this.#styles
        if (!sec.styleEls || st == null) return
        const [a, b] = sec.styleEls
        if (Array.isArray(st)) { a.textContent = st[0]; b.textContent = st[1] } else b.textContent = st
    }
    #measure(sec) {
        const doc = sec.doc
        if (!doc?.documentElement || !sec.loaded) return
        const h = Math.ceil(doc.documentElement.getBoundingClientRect().height)
        if (!h && sec.known) return
        const nh = Math.max(h, 1)
        if (sec.known && sec.h === nh) return
        sec.h = nh; sec.known = true
        sec.iframe.style.height = nh + 'px'
        sec.inner.style.height = nh + 'px'
        this.#layout()
        sec.overlayer?.redraw?.()
        this.#scheduleUpdate()
    }
    #restyleAll() {
        for (const s of this.#secs) {
            if (s.loaded) { this.#prepDoc(s); this.#measure(s) }
            else if (s.known) s.known = false
        }
        this.#layout()
        this.#reanchor()
    }
    #onResize() {
        const w = this.#sc.clientWidth, h = this.#sc.clientHeight
        if (w === this.#lastW && h === this.#lastH) return
        const widthChanged = w !== this.#lastW
        this.#lastW = w; this.#lastH = h
        if (!this.#secs.length) return
        if (widthChanged) this.#restyleAll()
        else for (const s of this.#secs) if (s.loaded) this.#prepDoc(s)
        this.#scheduleUpdate()
    }

    // ---------- which chapters should be loaded ----------
    #raf = 0
    #scheduleUpdate() {
        if (this.#raf || this.#destroyed) return
        this.#raf = requestAnimationFrame(() => { this.#raf = 0; this.#update() })
    }
    #onScroll() {
        this.#scheduleUpdate()
        this.#scheduleRelocate()
    }
    #update() {
        if (this.#destroyed || !this.#secs.length) return
        const y = this.#sc.scrollTop, H = this.#sc.clientHeight || 600
        const wantLo = y - H * 2, wantHi = y + H * 3
        const keepLo = y - H * 5, keepHi = y + H * 6
        const near = []
        for (const s of this.#secs) {
            const bottom = s.top + s.boxH
            if (bottom >= wantLo && s.top <= wantHi) near.push(s)
            else if (s.loaded && s.index !== this.#pin && (bottom < keepLo || s.top > keepHi)) this.#unload(s)
        }
        // nearest to the reading position first
        near.sort((a, b) => Math.abs(a.top - y) - Math.abs(b.top - y))
        for (const s of near) this.#load(s)
    }

    // ---------- reporting where the reader is ----------
    #scheduleRelocate() {
        if (this.#relocTimer) return
        const wait = Math.max(0, 110 - (performance.now() - this.#lastReloc))
        this.#relocTimer = setTimeout(() => { this.#relocTimer = 0; this.#relocate('scroll') }, wait)
    }
    #relocate(reason) {
        if (this.#destroyed || !this.#secs.length) return
        clearTimeout(this.#relocTimer); this.#relocTimer = 0
        const y = this.#sc.scrollTop, H = this.#sc.clientHeight
        let sec = this.#at(y + 1)
        // at the very bottom the reader has reached the last page, even if the last chapter is short
        if (this.atEnd) sec = this.#secs[this.#secs.length - 1]
        // a chapter that is still loading cannot say where we are
        if (!sec.loaded || !sec.doc || sec.failed) {
            if (!sec.loaded) this.#load(sec).then(() => this.#relocate(reason))
            if (!sec.doc) return
        }
        this.#lastReloc = performance.now()
        const doc = sec.doc
        const inDoc = y - (sec.top + this.#margin)
        const start = Math.max(0, inDoc), end = Math.max(start + 1, inDoc + H)
        let range
        try { range = getVisibleRange(doc, start, end, ({ top, bottom }) => ({ left: top, right: bottom })) } catch (e) { range = null }
        if (!range) return
        this.#anchorRange = range
        let fraction = sec.h > 0 ? Math.max(0, Math.min(1, inDoc / sec.h)) : 0
        if (this.atEnd && sec === this.#secs[this.#secs.length - 1]) fraction = 1
        this.dispatchEvent(new CustomEvent('relocate', { detail: { reason, range, index: sec.index, fraction } }))
    }

    // ---------- moving ----------
    #cancelGlide() {
        if (this.#anim) { cancelAnimationFrame(this.#anim.raf); this.#anim.done(); this.#anim = null }
        this.#pageTarget = null
    }
    #glide(to, ms = 300) {
        this.#cancelGlide()
        const sc = this.#sc
        const max = Math.max(0, sc.scrollHeight - sc.clientHeight)
        to = Math.max(0, Math.min(max, to))
        const from = sc.scrollTop
        if (Math.abs(to - from) < 1 || document.hidden) { sc.scrollTop = to; return Promise.resolve() }
        return new Promise(resolve => {
            const t0 = performance.now()
            const a = this.#anim = { raf: 0, done: resolve }
            const step = now => {
                if (this.#anim !== a) return
                const f = Math.min(1, (now - t0) / ms)
                sc.scrollTop = from + (to - from) * ease(f)
                if (f < 1) a.raf = requestAnimationFrame(step)
                else { this.#anim = null; this.#pageTarget = null; resolve() }
            }
            a.raf = requestAnimationFrame(step)
        })
    }
    // The page counter counts 1,500 units of book text per page. These two turn a scroll
    // position into "units of text read so far" and back, so one arrow press can move exactly one page.
    #unitsAt(y) {
        const sec = this.#at(y + 1)
        let before = 0
        for (const s of this.#secs) { if (s === sec) break; before += s.size }
        const inDoc = Math.max(0, Math.min(this.#heightOf(sec), y - sec.top - this.#margin))
        return before + (this.#heightOf(sec) > 0 ? inDoc / this.#heightOf(sec) : 0) * sec.size
    }
    #yAtUnits(u) {
        let before = 0, last = this.#secs[0]
        for (const s of this.#secs) {
            if (s.size <= 0) continue
            last = s
            if (u < before + s.size) return s.top + this.#margin + (u - before) / s.size * this.#heightOf(s)
            before += s.size
        }
        return last.top + last.boxH
    }
    // move by whole counted pages (the number in the toolbar changes by one), but never
    // further than most of a screen so no text is skipped over
    pages(n) {
        const base = this.#anim && this.#pageTarget != null ? this.#pageTarget : this.#sc.scrollTop
        const H = this.#sc.clientHeight
        let step = this.#yAtUnits(this.#unitsAt(base) + n * 1500) - base
        const cap = H * 0.9
        step = Math.max(-cap, Math.min(cap, step))
        if (Math.abs(step) < 40) step = Math.sign(n) * Math.min(cap, 300)
        const target = Math.max(0, Math.min(this.#sc.scrollHeight - H, base + step))
        const p = this.#glide(target, 280)
        this.#pageTarget = target
        return p
    }
    next(distance) { return distance ? this.#glide(this.#sc.scrollTop + distance) : this.pages(1) }
    prev(distance) { return distance ? this.#glide(this.#sc.scrollTop - distance) : this.pages(-1) }
    scrollByPixels(dy) { this.#sc.scrollTop += dy }

    #nearestIndex(index) {
        if (this.#byIndex.has(index)) return index
        for (let i = index + 1; i < this.sections.length; i++) if (this.#byIndex.has(i)) return i
        for (let i = index - 1; i >= 0; i--) if (this.#byIndex.has(i)) return i
        return null
    }
    #targetY(sec, anchor) {
        const m = this.#margin
        let a = typeof anchor === 'function' ? anchor(sec.doc) : anchor
        if (a == null) return sec.top
        if (typeof a === 'number') return sec.top + Math.max(0, Math.min(1, a)) * sec.h
        a = uncollapse(a)
        const rects = a?.getClientRects?.()
        if (!rects || !rects.length) return sec.top
        const r = Array.from(rects).find(x => x.width > 0 && x.height > 0) || rects[0]
        return sec.top + r.top
    }
    async goTo(target, reason = 'navigation') {
        const resolved = await target
        if (this.#destroyed || !resolved) return
        const index = this.#nearestIndex(resolved.index)
        if (index == null) return
        const { anchor, select } = resolved
        const sec = this.#byIndex.get(index)
        const pos = this.#secs.indexOf(sec)
        this.#cancelGlide()
        this.#pin = index
        const hadFocus = this.#secs.some(s => s.doc?.hasFocus?.())
        // load the target and its neighbours so heights around it are real before we jump
        const job = Promise.all([this.#load(sec), this.#load(this.#secs[pos - 1]), this.#load(this.#secs[pos + 1])])
        await job
        if (this.#destroyed) return
        let last = -1
        for (let i = 0; i < 4; i++) {
            if (!sec.doc && !sec.failed) break
            const y = sec.doc ? this.#targetY(sec, anchor) : sec.top
            if (Math.abs(y - last) < 1.5 && i > 0) break
            this.#sc.scrollTop = Math.max(0, y)
            last = y
            await frame()
        }
        this.#pin = -1
        this.#update()
        this.#relocate(select ? 'selection' : reason)
        if (hadFocus) this.focusView()
    }
    async scrollToAnchor(anchor, select) {
        const doc = anchor?.startContainer?.ownerDocument ?? anchor?.ownerDocument
        const sec = this.#secs.find(s => s.doc === doc)
        if (!sec) return
        const y = this.#targetY(sec, anchor)
        this.#sc.scrollTop = Math.max(0, y)
        this.#relocate(select ? 'selection' : 'navigation')
    }
    // after the layout changes (zoom, window size) keep the same words at the top
    #reanchorTimer = 0
    #reanchor() {
        clearTimeout(this.#reanchorTimer)
        const range = this.#anchorRange
        this.#reanchorTimer = setTimeout(async () => {
            if (!range || !range.startContainer.isConnected) return
            const doc = range.startContainer.ownerDocument
            const sec = this.#secs.find(s => s.doc === doc)
            if (!sec) return
            await frame()
            this.#sc.scrollTop = Math.max(0, this.#targetY(sec, range))
            this.#relocate('anchor')
        }, 140)
    }
    prevSection() { const i = this.#at(this.#sc.scrollTop + 1); const k = this.#secs.indexOf(i); return k > 0 ? this.goTo({ index: this.#secs[k - 1].index }) : undefined }
    nextSection() { const i = this.#at(this.#sc.scrollTop + 1); const k = this.#secs.indexOf(i); return k < this.#secs.length - 1 ? this.goTo({ index: this.#secs[k + 1].index }) : undefined }
    firstSection() { return this.#secs.length ? this.goTo({ index: this.#secs[0].index }) : undefined }
    lastSection() { return this.#secs.length ? this.goTo({ index: this.#secs.at(-1).index }) : undefined }

    // ---------- auto scroll ----------
    get autoScrolling() { return !!this.#auto }
    startAuto(pxPerSecond) {
        this.#cancelGlide()
        if (this.#auto) { this.#auto.v = pxPerSecond; return }
        const a = this.#auto = { v: pxPerSecond, carry: 0, last: 0 }
        const step = now => {
            if (this.#auto !== a) return
            const dt = a.last ? Math.min(0.1, (now - a.last) / 1000) : 0
            a.last = now
            a.carry += a.v * dt
            const whole = Math.floor(a.carry)
            if (whole >= 1) { this.#sc.scrollTop += whole; a.carry -= whole }
            if (this.atEnd) { this.stopAuto(); this.dispatchEvent(new Event('autoend')); return }
            a.raf = requestAnimationFrame(step)
        }
        a.raf = requestAnimationFrame(step)
    }
    setAutoSpeed(pxPerSecond) { if (this.#auto) this.#auto.v = pxPerSecond }
    stopAuto() { if (this.#auto) { cancelAnimationFrame(this.#auto.raf); this.#auto = null } }

    // ---------- what the rest of the app asks for ----------
    getContents() {
        return this.#secs.filter(s => s.loaded && s.doc).map(s => ({ index: s.index, overlayer: s.overlayer, doc: s.doc }))
    }
    setStyles(styles) {
        const key = JSON.stringify(styles)
        const changed = key !== this.#stylesKey
        this.#stylesKey = key
        this.#styles = styles
        for (const s of this.#secs) if (s.loaded) this.#applyStyles(s)
        if (changed && this.#secs.some(s => s.loaded)) {
            // text may have reflowed: forget estimates for chapters we are not showing
            for (const s of this.#secs) if (!s.loaded) s.known = false
            this.#layout()
            this.#reanchor()
            for (const s of this.#secs) if (s.loaded) s.doc.fonts?.ready?.then(() => this.#measure(s))
        }
    }
    focusView() {
        const sec = this.#at(this.#sc.scrollTop + this.#sc.clientHeight / 2)
        try { (sec?.iframe ?? this.#secs.find(s => s.iframe)?.iframe)?.contentWindow?.focus() } catch {}
    }
    destroy() {
        this.#destroyed = true
        this.stopAuto(); this.#cancelGlide()
        clearTimeout(this.#relocTimer); clearTimeout(this.#reanchorTimer)
        this.#ro.disconnect()
        for (const s of this.#secs) this.#unload(s)
        this.#secs = []
    }
    // for tests and tools
    get debug() { return { secs: this.#secs.map(s => ({ i: s.index, top: s.top, h: s.h, known: s.known, loaded: s.loaded })), rpu: this.#rpu } }
}

customElements.define('foliate-scroller', Scroller)
