(function () {
    const INIT_SYM = Symbol.for("__pwnfox_main_init__");
    const CTX_SYM = Symbol.for("__pwnfox_ctx__");
    if (window[INIT_SYM]) return;
    window[INIT_SYM] = true;

    const TO_MAIN_EVENT = "__pwnfox_to_main__";
    const TO_ISO_EVENT = "__pwnfox_to_iso__";
    const GLOBAL_PREFIX = "__pf_";

    function fromBase64UrlUtf8(b64url) {
        const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
        const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
        const bin = atob(padded);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) {
            bytes[i] = bin.charCodeAt(i);
        }
        return new TextDecoder().decode(bytes);
    }

    function readContextFromServerTiming() {
        try {
            const nav = performance.getEntriesByType("navigation")[0];
            const st = nav && nav.serverTiming;
            if (!st || !st.length) return null;

            let color = null;
            let namespace = null;
            let bestPrio = -1;
            let pairs = [];

            for (let i = 0; i < st.length; i++) {
                const entry = st[i];
                if (entry.name === "pwnfox" && entry.description) {
                    const idx = entry.description.indexOf(":");
                    if (idx !== -1) {
                        color = entry.description.slice(0, idx);
                        namespace = entry.description.slice(idx + 1);
                    } else {
                        color = entry.description;
                        namespace = entry.description;
                    }
                } else if (entry.name === "pwnfox-ck" && entry.description) {
                    const colonIdx = entry.description.indexOf(":");
                    if (colonIdx !== -1) {
                        const prio = parseInt(entry.description.slice(0, colonIdx), 10);
                        const encoded = entry.description.slice(colonIdx + 1);
                        if (!Number.isNaN(prio) && prio >= bestPrio) {
                            bestPrio = prio;
                            try {
                                const parsed = JSON.parse(fromBase64UrlUtf8(encoded));
                                if (Array.isArray(parsed)) pairs = parsed;
                            } catch {
                                // ignore malformed
                            }
                        }
                    }
                }
            }

            if (color) return { color, namespace, pairs };
        } catch {
            // ignore
        }
        return null;
    }

    function readContextFromParentOrOpener() {
        try {
            if (window.parent && window.parent !== window && window.parent[CTX_SYM]) {
                return window.parent[CTX_SYM];
            }
        } catch {
            // cross-origin parent
        }
        try {
            if (window.opener && window.opener[CTX_SYM]) {
                return window.opener[CTX_SYM];
            }
        } catch {
            // cross-origin opener
        }
        return null;
    }

    let ctx = readContextFromServerTiming() || readContextFromParentOrOpener();

    // Hide internal PwnFox Server-Timing entries from page JS
    try {
        const stDesc = Object.getOwnPropertyDescriptor(PerformanceResourceTiming.prototype, "serverTiming");
        if (stDesc && stDesc.get) {
            const origGet = stDesc.get;
            Object.defineProperty(PerformanceResourceTiming.prototype, "serverTiming", {
                configurable: true,
                enumerable: stDesc.enumerable,
                get() {
                    const arr = origGet.call(this);
                    if (!arr || !arr.length) return arr;
                    return arr.filter(e => e.name !== "pwnfox" && e.name !== "pwnfox-ck");
                }
            });
        }
    } catch {
        // ignore
    }

    let activeColor = ctx ? ctx.color : null;
    let activeNamespace = ctx ? ctx.namespace : null;
    let activePrefix = activeNamespace ? `${GLOBAL_PREFIX}${activeNamespace}__` : null;

    let cookiePairs = [];
    function setCookiePairs(pairs) {
        cookiePairs = [];
        if (!Array.isArray(pairs)) return;
        for (const item of pairs) {
            if (Array.isArray(item) && item.length >= 2) {
                cookiePairs.push([String(item[0]), String(item[1])]);
            }
        }
    }
    if (ctx && Array.isArray(ctx.pairs)) {
        setCookiePairs(ctx.pairs);
    }
    let cookieSeq = 0;
    const pendingCookieAcks = new Map();

    try {
        Object.defineProperty(window, CTX_SYM, {
            configurable: true,
            enumerable: false,
            get() {
                return activeColor
                    ? { color: activeColor, namespace: activeNamespace, pairs: cookiePairs.map(([k, v]) => [k, v]) }
                    : null;
            }
        });
    } catch {
        // ignore
    }

    /* Storage Isolation (works both in container tabs and normal tabs to avoid cross-pollution) */
    function createStorageProxy(getRealStorage) {
        const methodCache = new Map();
        const storageTarget = typeof Storage !== "undefined" ? Object.create(Storage.prototype) : {};
        return new Proxy(storageTarget, {
            get(_target, prop) {
                const real = getRealStorage();
                const prefix = activePrefix;

                if (prop === "length") {
                    let count = 0;
                    for (let i = 0; i < real.length; i++) {
                        const k = real.key(i);
                        if (prefix ? k.startsWith(prefix) : !k.startsWith(GLOBAL_PREFIX)) {
                            count++;
                        }
                    }
                    return count;
                }

                if (prop === "key") {
                    if (!methodCache.has("key")) {
                        methodCache.set("key", function (index) {
                            const r = getRealStorage();
                            const p = activePrefix;
                            let seen = 0;
                            for (let i = 0; i < r.length; i++) {
                                const k = r.key(i);
                                if (p ? k.startsWith(p) : !k.startsWith(GLOBAL_PREFIX)) {
                                    if (seen === index) {
                                        return p ? k.slice(p.length) : k;
                                    }
                                    seen++;
                                }
                            }
                            return null;
                        });
                    }
                    return methodCache.get("key");
                }

                if (prop === "getItem") {
                    if (!methodCache.has("getItem")) {
                        methodCache.set("getItem", function (k) {
                            const r = getRealStorage();
                            const p = activePrefix;
                            const ks = String(k);
                            if (!p && ks.startsWith(GLOBAL_PREFIX)) return null;
                            return r.getItem(p ? p + ks : ks);
                        });
                    }
                    return methodCache.get("getItem");
                }

                if (prop === "setItem") {
                    if (!methodCache.has("setItem")) {
                        methodCache.set("setItem", function (k, v) {
                            const r = getRealStorage();
                            const p = activePrefix;
                            const ks = String(k);
                            if (!p && ks.startsWith(GLOBAL_PREFIX)) return;
                            r.setItem(p ? p + ks : ks, String(v));
                        });
                    }
                    return methodCache.get("setItem");
                }

                if (prop === "removeItem") {
                    if (!methodCache.has("removeItem")) {
                        methodCache.set("removeItem", function (k) {
                            const r = getRealStorage();
                            const p = activePrefix;
                            const ks = String(k);
                            if (!p && ks.startsWith(GLOBAL_PREFIX)) return;
                            r.removeItem(p ? p + ks : ks);
                        });
                    }
                    return methodCache.get("removeItem");
                }

                if (prop === "clear") {
                    if (!methodCache.has("clear")) {
                        methodCache.set("clear", function () {
                            const r = getRealStorage();
                            const p = activePrefix;
                            const toRemove = [];
                            for (let i = 0; i < r.length; i++) {
                                const k = r.key(i);
                                if (p ? k.startsWith(p) : !k.startsWith(GLOBAL_PREFIX)) {
                                    toRemove.push(k);
                                }
                            }
                            for (let i = 0; i < toRemove.length; i++) {
                                r.removeItem(toRemove[i]);
                            }
                        });
                    }
                    return methodCache.get("clear");
                }

                if (typeof prop === "symbol") {
                    return Reflect.get(real, prop, real);
                }

                if (prop in storageTarget) {
                    return Reflect.get(storageTarget, prop, storageTarget);
                }

                const ks = String(prop);
                if (!prefix && ks.startsWith(GLOBAL_PREFIX)) return undefined;
                const val = real.getItem(prefix ? prefix + ks : ks);
                return val === null ? undefined : val;
            },

            set(_target, prop, value) {
                if (typeof prop === "symbol") return false;
                const real = getRealStorage();
                const prefix = activePrefix;
                const ks = String(prop);
                if (!prefix && ks.startsWith(GLOBAL_PREFIX)) return true;
                real.setItem(prefix ? prefix + ks : ks, String(value));
                return true;
            },

            deleteProperty(_target, prop) {
                if (typeof prop === "symbol") return false;
                const real = getRealStorage();
                const prefix = activePrefix;
                const ks = String(prop);
                if (!prefix && ks.startsWith(GLOBAL_PREFIX)) return true;
                real.removeItem(prefix ? prefix + ks : ks);
                return true;
            },

            has(_target, prop) {
                if (prop in Storage.prototype) return true;
                if (typeof prop === "symbol") return false;
                const real = getRealStorage();
                const prefix = activePrefix;
                const ks = String(prop);
                if (!prefix && ks.startsWith(GLOBAL_PREFIX)) return false;
                return real.getItem(prefix ? prefix + ks : ks) !== null;
            },

            ownKeys() {
                const real = getRealStorage();
                const prefix = activePrefix;
                const keys = [];
                for (let i = 0; i < real.length; i++) {
                    const k = real.key(i);
                    if (prefix) {
                        if (k.startsWith(prefix)) keys.push(k.slice(prefix.length));
                    } else {
                        if (!k.startsWith(GLOBAL_PREFIX)) keys.push(k);
                    }
                }
                return keys;
            },

            getOwnPropertyDescriptor(_target, prop) {
                if (typeof prop === "symbol") return undefined;
                const real = getRealStorage();
                const prefix = activePrefix;
                const ks = String(prop);
                if (!prefix && ks.startsWith(GLOBAL_PREFIX)) return undefined;
                const val = real.getItem(prefix ? prefix + ks : ks);
                if (val === null) return undefined;
                return {
                    enumerable: true,
                    configurable: true,
                    writable: true,
                    value: val
                };
            }
        });
    }

    function installStorageHook(propName) {
        const targetObj = Object.getOwnPropertyDescriptor(window, propName)
            ? window
            : Window.prototype;
        const origDesc = Object.getOwnPropertyDescriptor(targetObj, propName);
        if (!origDesc || !origDesc.get || !origDesc.configurable) return;

        const origGet = origDesc.get;
        const proxyCache = new WeakMap();

        Object.defineProperty(targetObj, propName, {
            configurable: true,
            enumerable: origDesc.enumerable,
            get() {
                const real = origGet.call(this);
                let proxy = proxyCache.get(real);
                if (!proxy) {
                    proxy = createStorageProxy(() => origGet.call(this));
                    proxyCache.set(real, proxy);
                }
                return proxy;
            }
        });
    }

    installStorageHook("localStorage");
    installStorageHook("sessionStorage");

    // Filter storage events (both addEventListener and window.onstorage) so cross-container / prefixed keys don't leak
    try {
        const origAddEventListener = EventTarget.prototype.addEventListener;
        const origRemoveEventListener = EventTarget.prototype.removeEventListener;
        const wrappedStorageListeners = new WeakMap();

        function createFilteredStorageHandler(listener) {
            return function (ev) {
                const k = ev.key;
                if (k !== null) {
                    if (activePrefix) {
                        if (!k.startsWith(activePrefix)) return;
                    } else {
                        if (k.startsWith(GLOBAL_PREFIX)) return;
                    }
                }
                const unprefixedKey = (k && activePrefix && k.startsWith(activePrefix))
                    ? k.slice(activePrefix.length)
                    : k;
                const proxiedEv = new Proxy(ev, {
                    get(t, p) {
                        if (p === "key") return unprefixedKey;
                        const v = Reflect.get(t, p, t);
                        return typeof v === "function" ? v.bind(t) : v;
                    }
                });
                return listener.call(this, proxiedEv);
            };
        }

        EventTarget.prototype.addEventListener = function (type, listener, options) {
            if (this === window && type === "storage" && typeof listener === "function") {
                let wrapped = wrappedStorageListeners.get(listener);
                if (!wrapped) {
                    wrapped = createFilteredStorageHandler(listener);
                    wrappedStorageListeners.set(listener, wrapped);
                }
                return origAddEventListener.call(this, type, wrapped, options);
            }
            return origAddEventListener.call(this, type, listener, options);
        };

        EventTarget.prototype.removeEventListener = function (type, listener, options) {
            if (this === window && type === "storage" && typeof listener === "function") {
                const wrapped = wrappedStorageListeners.get(listener);
                if (wrapped) {
                    return origRemoveEventListener.call(this, type, wrapped, options);
                }
            }
            return origRemoveEventListener.call(this, type, listener, options);
        };

        const onStorageTarget = Object.getOwnPropertyDescriptor(window, "onstorage")
            ? window
            : Window.prototype;
        const origOnStorageDesc = Object.getOwnPropertyDescriptor(onStorageTarget, "onstorage");
        if (origOnStorageDesc && origOnStorageDesc.configurable && origOnStorageDesc.set) {
            const rawOnStorageMap = new WeakMap();
            Object.defineProperty(onStorageTarget, "onstorage", {
                configurable: true,
                enumerable: origOnStorageDesc.enumerable,
                get() {
                    return rawOnStorageMap.get(this) ?? null;
                },
                set(fn) {
                    if (typeof fn === "function") {
                        rawOnStorageMap.set(this, fn);
                        let wrapped = wrappedStorageListeners.get(fn);
                        if (!wrapped) {
                            wrapped = createFilteredStorageHandler(fn);
                            wrappedStorageListeners.set(fn, wrapped);
                        }
                        origOnStorageDesc.set.call(this, wrapped);
                    } else {
                        rawOnStorageMap.set(this, null);
                        origOnStorageDesc.set.call(this, null);
                    }
                }
            });
        }
    } catch {
        // ignore
    }

    /* IndexedDB Isolation */
    try {
        const origIdbOpen = IDBFactory.prototype.open;
        const origIdbDelete = IDBFactory.prototype.deleteDatabase;
        const origIdbDatabases = IDBFactory.prototype.databases;
        const idbNameDesc = Object.getOwnPropertyDescriptor(IDBDatabase.prototype, "name");

        IDBFactory.prototype.open = function (name, version) {
            const nameStr = String(name);
            const targetName = activePrefix
                ? activePrefix + nameStr
                : nameStr;
            return arguments.length >= 2
                ? origIdbOpen.call(this, targetName, version)
                : origIdbOpen.call(this, targetName);
        };

        IDBFactory.prototype.deleteDatabase = function (name) {
            const nameStr = String(name);
            const targetName = activePrefix
                ? activePrefix + nameStr
                : nameStr;
            return origIdbDelete.call(this, targetName);
        };

        if (origIdbDatabases) {
            IDBFactory.prototype.databases = async function () {
                const list = await origIdbDatabases.call(this);
                if (activePrefix) {
                    return list
                        .filter(d => d.name && d.name.startsWith(activePrefix))
                        .map(d => ({ ...d, name: d.name.slice(activePrefix.length) }));
                }
                return list.filter(d => !d.name || !d.name.startsWith(GLOBAL_PREFIX));
            };
        }

        if (idbNameDesc && idbNameDesc.get) {
            const origNameGet = idbNameDesc.get;
            Object.defineProperty(IDBDatabase.prototype, "name", {
                configurable: true,
                enumerable: idbNameDesc.enumerable,
                get() {
                    const realName = origNameGet.call(this);
                    if (activePrefix && realName && realName.startsWith(activePrefix)) {
                        return realName.slice(activePrefix.length);
                    }
                    return realName;
                }
            });
        }
    } catch {
        // ignore if indexedDB unavailable
    }

    /* CacheStorage Isolation */
    try {
        if (typeof CacheStorage !== "undefined") {
            const origCacheOpen = CacheStorage.prototype.open;
            const origCacheHas = CacheStorage.prototype.has;
            const origCacheDelete = CacheStorage.prototype.delete;
            const origCacheKeys = CacheStorage.prototype.keys;
            const origCacheMatch = CacheStorage.prototype.match;

            CacheStorage.prototype.open = function (cacheName) {
                const name = String(cacheName);
                return origCacheOpen.call(this, activePrefix ? activePrefix + name : name);
            };

            CacheStorage.prototype.has = function (cacheName) {
                const name = String(cacheName);
                if (!activePrefix && name.startsWith(GLOBAL_PREFIX)) return Promise.resolve(false);
                return origCacheHas.call(this, activePrefix ? activePrefix + name : name);
            };

            CacheStorage.prototype.delete = function (cacheName) {
                const name = String(cacheName);
                if (!activePrefix && name.startsWith(GLOBAL_PREFIX)) return Promise.resolve(false);
                return origCacheDelete.call(this, activePrefix ? activePrefix + name : name);
            };

            CacheStorage.prototype.keys = async function () {
                const all = await origCacheKeys.call(this);
                if (activePrefix) {
                    return all
                        .filter(k => k.startsWith(activePrefix))
                        .map(k => k.slice(activePrefix.length));
                }
                return all.filter(k => !k.startsWith(GLOBAL_PREFIX));
            };

            CacheStorage.prototype.match = async function (request, options) {
                if (options && options.cacheName) {
                    const prefixedOpts = {
                        ...options,
                        cacheName: activePrefix ? activePrefix + options.cacheName : options.cacheName
                    };
                    return origCacheMatch.call(this, request, prefixedOpts);
                }
                const keys = await this.keys();
                for (const k of keys) {
                    const cache = await this.open(k);
                    const hit = await cache.match(request, options);
                    if (hit) return hit;
                }
                return undefined;
            };
        }
    } catch {
        // ignore
    }

    /* Container-only hooks: document.cookie, cookieStore, BroadcastChannel, ServiceWorker, fetch/XHR sync */
    let containerHooksInstalled = false;

    function applyLocalCookieString(rawStr) {
        if (typeof rawStr !== "string") return;
        const parts = rawStr.split(";");
        const eqIdx = parts[0].indexOf("=");
        if (eqIdx <= 0) return;

        const name = parts[0].slice(0, eqIdx).trim();
        const value = parts[0].slice(eqIdx + 1).trim();
        if (!name || /[\x00-\x20()<>@,;:\\"\/\[\]?={}\x7f]/.test(name)) return;
        if (/[\x00-\x08\x0a-\x1f\x7f]/.test(value)) return;

        const host = location.hostname.toLowerCase();
        const pathNow = location.pathname || "/";
        const isTrustworthy = location.protocol === "https:" || host === "localhost" || host === "127.0.0.1" || host.endsWith(".localhost");

        let attrDomain = null;
        let attrPath = null;
        let maxAge = null;
        let expiresAt = null;
        let secure = false;
        let httpOnly = false;

        for (let i = 1; i < parts.length; i++) {
            const seg = parts[i].trim();
            if (!seg) continue;
            const attrEq = seg.indexOf("=");
            const attrName = (attrEq === -1 ? seg : seg.slice(0, attrEq)).trim().toLowerCase();
            const attrVal = attrEq === -1 ? "" : seg.slice(attrEq + 1).trim();

            if (attrName === "domain") {
                const cleaned = attrVal.replace(/^\.+/, "").toLowerCase();
                if (cleaned) attrDomain = cleaned;
            } else if (attrName === "path") {
                if (attrVal.startsWith("/")) attrPath = attrVal;
            } else if (attrName === "max-age") {
                if (/^-?\d+$/.test(attrVal)) maxAge = parseInt(attrVal, 10);
            } else if (attrName === "expires") {
                const parsed = Date.parse(attrVal);
                if (!Number.isNaN(parsed)) expiresAt = parsed;
            } else if (attrName === "secure") {
                secure = true;
            } else if (attrName === "httponly") {
                httpOnly = true;
            }
        }

        if (httpOnly) return;
        if (secure && !isTrustworthy) return;
        if (name.startsWith("__Secure-") && (!secure || !isTrustworthy)) return;
        if (name.startsWith("__Host-") && (!secure || !isTrustworthy || attrDomain !== null || (attrPath && attrPath !== "/"))) return;

        if (attrDomain !== null) {
            const isIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":");
            if (isIp ? host !== attrDomain : (host !== attrDomain && !host.endsWith("." + attrDomain))) {
                return;
            }
        }

        const effectivePath = attrPath !== null
            ? attrPath
            : (pathNow.lastIndexOf("/") <= 0 ? "/" : pathNow.slice(0, pathNow.lastIndexOf("/")));

        const pathMatch = pathNow === effectivePath
            || (pathNow.startsWith(effectivePath) && (effectivePath.endsWith("/") || pathNow[effectivePath.length] === "/"));

        const shouldDelete = (maxAge !== null && maxAge <= 0) || (maxAge === null && expiresAt !== null && expiresAt <= Date.now());
        if (shouldDelete) {
            if (pathMatch) {
                cookiePairs = cookiePairs.filter(([k]) => k !== name);
            }
            return;
        }

        if (pathMatch) {
            const idx = cookiePairs.findIndex(([k]) => k === name);
            if (idx !== -1) {
                cookiePairs[idx][1] = value;
            } else {
                cookiePairs.push([name, value]);
            }
        }
    }

    function sendCookieWriteToBackground(cookieString) {
        const seq = ++cookieSeq;
        const ackPromise = new Promise((resolve) => {
            const timer = setTimeout(() => {
                pendingCookieAcks.delete(seq);
                pendingCookieAcks.delete(`p_${seq}`);
                resolve();
            }, 1500);
            pendingCookieAcks.set(seq, () => {
                clearTimeout(timer);
                pendingCookieAcks.delete(seq);
                pendingCookieAcks.delete(`p_${seq}`);
                resolve();
            });
        });
        pendingCookieAcks.set(`p_${seq}`, ackPromise);

        window.dispatchEvent(new CustomEvent(TO_ISO_EVENT, {
            detail: JSON.stringify({
                type: "SET_DOCUMENT_COOKIE",
                seq,
                cookieString,
                url: location.href
            })
        }));

        return ackPromise;
    }

    async function awaitPendingCookieSyncs() {
        const promises = [];
        for (const [k, v] of pendingCookieAcks.entries()) {
            if (typeof k === "string" && k.startsWith("p_")) {
                promises.push(v);
            }
        }
        if (promises.length > 0) {
            await Promise.all(promises);
        }
    }

    function installContainerOnlyHooks() {
        if (containerHooksInstalled) return;
        containerHooksInstalled = true;

        // 1. document.cookie
        try {
            Object.defineProperty(Document.prototype, "cookie", {
                configurable: true,
                enumerable: true,
                get() {
                    const out = [];
                    for (let i = 0; i < cookiePairs.length; i++) {
                        out.push(`${cookiePairs[i][0]}=${cookiePairs[i][1]}`);
                    }
                    return out.join("; ");
                },
                set(val) {
                    const str = String(val);
                    applyLocalCookieString(str);
                    sendCookieWriteToBackground(str);
                }
            });
        } catch {
            // ignore
        }

        // 2. window.cookieStore (if available)
        try {
            if (typeof CookieStore !== "undefined") {
                CookieStore.prototype.get = async function (init) {
                    const name = typeof init === "string" ? init : init?.name;
                    if (!name) return null;
                    const found = cookiePairs.find(([k]) => k === name);
                    if (!found) return null;
                    return { name: found[0], value: found[1], domain: location.hostname, path: "/" };
                };
                CookieStore.prototype.getAll = async function (init) {
                    const filterName = typeof init === "string" ? init : init?.name;
                    const res = [];
                    for (let i = 0; i < cookiePairs.length; i++) {
                        const [name, value] = cookiePairs[i];
                        if (!filterName || filterName === name) {
                            res.push({ name, value, domain: location.hostname, path: "/" });
                        }
                    }
                    return res;
                };
                CookieStore.prototype.set = async function (init, valueArg) {
                    let str;
                    if (typeof init === "string") {
                        str = `${init}=${valueArg ?? ""}; Path=/`;
                    } else if (init && typeof init === "object") {
                        const parts = [`${init.name}=${init.value ?? ""}`];
                        if (init.domain) parts.push(`Domain=${init.domain}`);
                        parts.push(`Path=${init.path || "/"}`);
                        if (init.expires) parts.push(`Expires=${new Date(init.expires).toUTCString()}`);
                        if (init.sameSite) parts.push(`SameSite=${init.sameSite}`);
                        str = parts.join("; ");
                    }
                    if (str) {
                        applyLocalCookieString(str);
                        await sendCookieWriteToBackground(str);
                    }
                };
                CookieStore.prototype.delete = async function (init) {
                    const name = typeof init === "string" ? init : init?.name;
                    const path = (typeof init === "object" && init?.path) ? init.path : "/";
                    const domain = (typeof init === "object" && init?.domain) ? `; Domain=${init.domain}` : "";
                    if (name) {
                        const str = `${name}=; Path=${path}${domain}; Max-Age=0`;
                        applyLocalCookieString(str);
                        await sendCookieWriteToBackground(str);
                    }
                };
            }
        } catch {
            // ignore
        }

        // 3. Flush pending document.cookie writes before fetch/XHR sends
        try {
            const origFetch = window.fetch;
            window.fetch = function (...args) {
                if (pendingCookieAcks.size > 0) {
                    return awaitPendingCookieSyncs().then(() => origFetch.apply(this, args));
                }
                return origFetch.apply(this, args);
            };
        } catch {
            // ignore
        }

        try {
            const origOpen = XMLHttpRequest.prototype.open;
            const origSend = XMLHttpRequest.prototype.send;
            const xhrAsyncMap = new WeakMap();

            XMLHttpRequest.prototype.open = function (method, url, asyncFlag = true, ...rest) {
                xhrAsyncMap.set(this, asyncFlag !== false);
                return origOpen.call(this, method, url, asyncFlag, ...rest);
            };

            XMLHttpRequest.prototype.send = function (body) {
                const isAsync = xhrAsyncMap.get(this) !== false;
                if (isAsync && pendingCookieAcks.size > 0) {
                    awaitPendingCookieSyncs().then(() => origSend.call(this, body));
                    return;
                }
                return origSend.call(this, body);
            };
        } catch {
            // ignore
        }

        // 4. BroadcastChannel Isolation
        try {
            const OrigBC = window.BroadcastChannel;
            if (OrigBC) {
                const bcNameDesc = Object.getOwnPropertyDescriptor(OrigBC.prototype, "name");
                const WrappedBC = function (name) {
                    const realName = activePrefix ? activePrefix + String(name) : String(name);
                    return new OrigBC(realName);
                };
                WrappedBC.prototype = OrigBC.prototype;
                if (bcNameDesc && bcNameDesc.get) {
                    const origGet = bcNameDesc.get;
                    Object.defineProperty(OrigBC.prototype, "name", {
                        configurable: true,
                        get() {
                            const n = origGet.call(this);
                            if (activePrefix && n.startsWith(activePrefix)) {
                                return n.slice(activePrefix.length);
                            }
                            return n;
                        }
                    });
                }
                window.BroadcastChannel = WrappedBC;
            }
        } catch {
            // ignore
        }

        // 5. Block ServiceWorker registration inside containers (prevents cross-container SW/cache sharing)
        try {
            if (typeof ServiceWorkerContainer !== "undefined") {
                ServiceWorkerContainer.prototype.register = function () {
                    return Promise.reject(new DOMException("ServiceWorker is disabled inside PwnFox containers.", "SecurityError"));
                };
                ServiceWorkerContainer.prototype.getRegistration = function () {
                    return Promise.resolve(undefined);
                };
                ServiceWorkerContainer.prototype.getRegistrations = function () {
                    return Promise.resolve([]);
                };
            }
        } catch {
            // ignore
        }

        // 6. SharedWorker Isolation (isolate by prefixing worker name per container)
        try {
            const OrigSharedWorker = window.SharedWorker;
            if (OrigSharedWorker) {
                const WrappedSharedWorker = function (scriptURL, options) {
                    if (activePrefix) {
                        if (typeof options === "string") {
                            return new OrigSharedWorker(scriptURL, activePrefix + options);
                        }
                        if (options && typeof options === "object") {
                            return new OrigSharedWorker(scriptURL, {
                                ...options,
                                name: activePrefix + (options.name !== undefined ? String(options.name) : "")
                            });
                        }
                        return new OrigSharedWorker(scriptURL, activePrefix);
                    }
                    return arguments.length >= 2
                        ? new OrigSharedWorker(scriptURL, options)
                        : new OrigSharedWorker(scriptURL);
                };
                WrappedSharedWorker.prototype = OrigSharedWorker.prototype;
                window.SharedWorker = WrappedSharedWorker;
            }
        } catch {
            // ignore
        }

        // 7. Web Locks API (navigator.locks) Isolation
        try {
            if (typeof LockManager !== "undefined") {
                const origRequest = LockManager.prototype.request;
                LockManager.prototype.request = function (name, optionsOrCb, maybeCb) {
                    const targetName = activePrefix ? activePrefix + String(name) : String(name);
                    if (arguments.length >= 3) {
                        return origRequest.call(this, targetName, optionsOrCb, maybeCb);
                    }
                    return origRequest.call(this, targetName, optionsOrCb);
                };
                if (LockManager.prototype.query) {
                    const origQuery = LockManager.prototype.query;
                    LockManager.prototype.query = async function () {
                        const snapshot = await origQuery.call(this);
                        const mapList = (arr) => {
                            if (!Array.isArray(arr)) return arr;
                            if (activePrefix) {
                                return arr
                                    .filter(item => item?.name && item.name.startsWith(activePrefix))
                                    .map(item => ({ ...item, name: item.name.slice(activePrefix.length) }));
                            }
                            return arr.filter(item => !item?.name || !item.name.startsWith(GLOBAL_PREFIX));
                        };
                        return {
                            held: mapList(snapshot.held),
                            pending: mapList(snapshot.pending)
                        };
                    };
                }
            }
        } catch {
            // ignore
        }
    }

    if (activeColor) {
        installContainerOnlyHooks();
    }

    let initContextApplied = false;

    /* Listen for updates from ISOLATED world */
    window.addEventListener(TO_MAIN_EVENT, (ev) => {
        let msg;
        try {
            msg = typeof ev.detail === "string" ? JSON.parse(ev.detail) : ev.detail;
        } catch {
            return;
        }
        if (!msg || typeof msg !== "object") return;

        if (msg.type === "INIT_CONTEXT") {
            if (!activeColor && msg.color) {
                activeColor = msg.color;
                activeNamespace = msg.namespace;
                activePrefix = `${GLOBAL_PREFIX}${activeNamespace}__`;
                installContainerOnlyHooks();
            }
            if (!initContextApplied) {
                initContextApplied = true;
                if (Array.isArray(msg.pairs) && cookieSeq === 0 && pendingCookieAcks.size === 0) {
                    setCookiePairs(msg.pairs);
                }
            }
        } else if (msg.type === "ACK_DOCUMENT_COOKIE") {
            const resolver = pendingCookieAcks.get(msg.seq);
            pendingCookieAcks.delete(`p_${msg.seq}`);
            if (Array.isArray(msg.pairs) && msg.seq === cookieSeq) {
                setCookiePairs(msg.pairs);
            }
            if (resolver) resolver();
        } else if (msg.type === "COOKIES_UPDATED") {
            if (Array.isArray(msg.pairs) && pendingCookieAcks.size === 0) {
                setCookiePairs(msg.pairs);
            }
        } else if (msg.type === "CONTAINER_CLEARED") {
            if (msg.color === activeColor) {
                activeNamespace = msg.namespace;
                activePrefix = `${GLOBAL_PREFIX}${activeNamespace}__`;
                cookiePairs = [];
                cookieSeq++;
                for (const [k, v] of pendingCookieAcks.entries()) {
                    if (typeof k === "number" && typeof v === "function") {
                        v();
                    }
                }
                pendingCookieAcks.clear();
            }
        }
    });
})();
