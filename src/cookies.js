(function (root) {
    const ALL_RESOURCE_TYPES = [
        "main_frame",
        "sub_frame",
        "stylesheet",
        "script",
        "image",
        "font",
        "object",
        "xmlhttprequest",
        "ping",
        "csp_report",
        "media",
        "websocket",
        "webtransport",
        "webbundle",
        "other"
    ];

    function isIpAddress(hostname) {
        if (!hostname) return false;
        if (hostname.includes(":")) return true;
        return /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname);
    }

    function isTrustworthyUrl(urlObj) {
        if (urlObj.protocol === "https:") return true;
        const h = urlObj.hostname.toLowerCase();
        return h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h.endsWith(".localhost");
    }

    function getDefaultPath(pathname) {
        if (!pathname || !pathname.startsWith("/")) return "/";
        const lastSlash = pathname.lastIndexOf("/");
        if (lastSlash <= 0) return "/";
        return pathname.slice(0, lastSlash);
    }

    function domainMatches(hostname, cookieDomain, hostOnly) {
        const h = hostname.toLowerCase();
        const d = cookieDomain.toLowerCase();
        if (hostOnly) return h === d;
        if (h === d) return true;
        if (isIpAddress(h)) return false;
        return h.endsWith("." + d);
    }

    function pathMatches(requestPath, cookiePath) {
        const reqPath = requestPath || "/";
        if (reqPath === cookiePath) return true;
        if (!reqPath.startsWith(cookiePath)) return false;
        if (cookiePath.endsWith("/")) return true;
        return reqPath[cookiePath.length] === "/";
    }

    function makeCookieKey(cookie) {
        return `${cookie.domain}\t${cookie.path}\t${cookie.name}`;
    }

    function parseCookieString(rawStr, requestUrlStr, options = {}) {
        const { fromDocumentCookie = false, now = Date.now() } = options;
        if (!rawStr || typeof rawStr !== "string") return null;

        let urlObj;
        try {
            urlObj = new URL(requestUrlStr);
        } catch {
            return null;
        }
        if (urlObj.protocol !== "http:" && urlObj.protocol !== "https:") return null;

        const parts = rawStr.split(";");
        const nameValuePart = parts[0];
        const eqIdx = nameValuePart.indexOf("=");
        if (eqIdx <= 0) return null;

        const name = nameValuePart.slice(0, eqIdx).trim();
        const value = nameValuePart.slice(eqIdx + 1).trim();
        if (!name || /[\x00-\x20()<>@,;:\\"\/\[\]?={}\x7f]/.test(name)) return null;
        if (/[\x00-\x08\x0a-\x1f\x7f]/.test(value)) return null;

        const reqHost = urlObj.hostname.toLowerCase();
        let attrDomain = null;
        let attrPath = null;
        let maxAge = null;
        let expiresAt = null;
        let secure = false;
        let httpOnly = false;
        let sawHttpOnly = false;
        let sameSite = "Lax";

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
                if (attrVal.startsWith("/")) {
                    attrPath = attrVal;
                }
            } else if (attrName === "max-age") {
                if (/^-?\d+$/.test(attrVal)) {
                    maxAge = parseInt(attrVal, 10);
                }
            } else if (attrName === "expires") {
                const parsed = Date.parse(attrVal);
                if (!Number.isNaN(parsed)) {
                    expiresAt = parsed;
                }
            } else if (attrName === "secure") {
                secure = true;
            } else if (attrName === "httponly") {
                sawHttpOnly = true;
                if (!fromDocumentCookie) {
                    httpOnly = true;
                }
            } else if (attrName === "samesite") {
                const lower = attrVal.toLowerCase();
                if (lower === "strict") sameSite = "Strict";
                else if (lower === "none") sameSite = "None";
                else sameSite = "Lax";
            }
        }

        if (fromDocumentCookie && sawHttpOnly) {
            // Browsers ignore HttpOnly cookies set via document.cookie
            return null;
        }

        let finalExpiresAt = null;
        if (maxAge !== null) {
            finalExpiresAt = maxAge <= 0 ? 0 : now + maxAge * 1000;
        } else if (expiresAt !== null) {
            finalExpiresAt = expiresAt;
        }

        let domain = reqHost;
        let hostOnly = true;
        if (attrDomain !== null) {
            if (!domainMatches(reqHost, attrDomain, false)) {
                return null;
            }
            if (isIpAddress(reqHost) && attrDomain !== reqHost) {
                return null;
            }
            domain = attrDomain;
            hostOnly = isIpAddress(reqHost);
        }

        const path = attrPath !== null ? attrPath : getDefaultPath(urlObj.pathname);

        // Cookie prefixes per RFC 6265bis
        if (name.startsWith("__Secure-")) {
            if (!secure || !isTrustworthyUrl(urlObj)) return null;
        }
        if (name.startsWith("__Host-")) {
            if (!secure || !isTrustworthyUrl(urlObj) || !hostOnly || path !== "/") return null;
        }

        return {
            name,
            value,
            domain,
            hostOnly,
            path,
            secure,
            httpOnly,
            sameSite,
            expiresAt: finalExpiresAt,
            updatedAt: now
        };
    }

    function applyCookieToJar(jar, cookie, options = {}) {
        const { fromDocumentCookie = false, now = Date.now() } = options;
        if (!cookie) return false;
        const key = makeCookieKey(cookie);
        const existing = jar[key];
        if (fromDocumentCookie && existing && existing.httpOnly) {
            return false;
        }
        if (cookie.expiresAt !== null && cookie.expiresAt <= now) {
            if (existing) {
                delete jar[key];
                return true;
            }
            return false;
        }
        let maxSeq = 0;
        if (!existing) {
            for (const c of Object.values(jar)) {
                if (typeof c.createdSeq === "number" && c.createdSeq > maxSeq) {
                    maxSeq = c.createdSeq;
                }
            }
        }
        jar[key] = {
            ...cookie,
            createdAt: existing ? existing.createdAt : now,
            createdSeq: existing ? (existing.createdSeq || 0) : (maxSeq + 1)
        };
        return true;
    }

    function pruneExpiredCookies(jar, now = Date.now()) {
        let changed = false;
        for (const [key, cookie] of Object.entries(jar)) {
            if (cookie.expiresAt !== null && cookie.expiresAt <= now) {
                delete jar[key];
                changed = true;
            }
        }
        return changed;
    }

    function getMatchingCookies(jar, urlStr, options = {}) {
        const { forDocumentCookie = false, excludeHostOnly = false, now = Date.now() } = options;
        let urlObj;
        try {
            urlObj = new URL(urlStr);
        } catch {
            return [];
        }
        if (urlObj.protocol !== "http:" && urlObj.protocol !== "https:") return [];

        const hostname = urlObj.hostname.toLowerCase();
        const pathname = urlObj.pathname || "/";
        const secureCtx = isTrustworthyUrl(urlObj);

        const matched = [];
        for (const cookie of Object.values(jar)) {
            if (cookie.expiresAt !== null && cookie.expiresAt <= now) continue;
            if (excludeHostOnly && cookie.hostOnly) continue;
            if (forDocumentCookie && cookie.httpOnly) continue;
            if (cookie.secure && !secureCtx) continue;
            if (!domainMatches(hostname, cookie.domain, cookie.hostOnly)) continue;
            if (!pathMatches(pathname, cookie.path)) continue;
            matched.push(cookie);
        }

        matched.sort((a, b) => {
            if (b.path.length !== a.path.length) return b.path.length - a.path.length;
            const ca = a.createdAt || 0;
            const cb = b.createdAt || 0;
            if (ca !== cb) return ca - cb;
            return (a.createdSeq || 0) - (b.createdSeq || 0);
        });

        return matched;
    }

    function formatCookieHeader(cookies) {
        return cookies.map(c => `${c.name}=${c.value}`).join("; ");
    }

    function escapeRegex(str) {
        return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }

    function toBase64UrlUtf8(str) {
        const bytes = new TextEncoder().encode(str);
        let bin = "";
        for (let i = 0; i < bytes.length; i++) {
            bin += String.fromCharCode(bytes[i]);
        }
        return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    }

    function buildRegexFilter(domain, hostOnly, path, schemeMode) {
        const schemePart = schemeMode === "https"
            ? "https"
            : (schemeMode === "http" ? "http" : "https?");
        const escapedDomain = escapeRegex(domain);
        const hostPart = hostOnly
            ? escapedDomain
            : `(?:[^/?#]+\\.)?${escapedDomain}`;

        let pathPart;
        if (path === "/") {
            pathPart = "/.*";
        } else if (path.endsWith("/")) {
            pathPart = `${escapeRegex(path)}.*`;
        } else {
            pathPart = `${escapeRegex(path)}(?:/.*)?(?:[?#].*)?$`;
        }
        return `^${schemePart}://${hostPart}(?::\\d+)?${pathPart}`;
    }

    function isLocalhostDomain(domain) {
        const d = domain.toLowerCase();
        return d === "localhost" || d === "127.0.0.1" || d === "[::1]" || d.endsWith(".localhost");
    }

    function buildCookieDnrSpecs(jar, now = Date.now()) {
        pruneExpiredCookies(jar, now);
        const cookies = Object.values(jar);
        if (cookies.length === 0) return [];

        // Group unique (domain, hostOnly) targets
        const domainTargets = new Map();
        for (const c of cookies) {
            const key = `${c.domain}\t${c.hostOnly ? "1" : "0"}`;
            if (!domainTargets.has(key)) {
                domainTargets.set(key, { domain: c.domain, hostOnly: c.hostOnly });
            }
        }

        const specs = [];
        for (const { domain, hostOnly } of domainTargets.values()) {
            // Find all cookies that could apply to this target.
            // Wildcard (hostOnly=false) rules match subdomains too, so they must never include hostOnly=true cookies.
            const applicableCookies = cookies.filter(c =>
                (!c.hostOnly || hostOnly) && domainMatches(domain, c.domain, c.hostOnly)
            );
            const paths = new Set(["/"]);
            let hasSecureNonLocal = false;
            let hasInsecure = false;

            for (const c of applicableCookies) {
                paths.add(c.path);
                if (c.secure && !isLocalhostDomain(domain)) {
                    hasSecureNonLocal = true;
                } else {
                    hasInsecure = true;
                }
            }

            const schemeModes = [];
            if (hasSecureNonLocal && hasInsecure) {
                schemeModes.push("https", "http");
            } else if (hasSecureNonLocal && !hasInsecure) {
                schemeModes.push("https");
            } else {
                schemeModes.push("both");
            }

            for (const path of paths) {
                for (const schemeMode of schemeModes) {
                    const testScheme = schemeMode === "https" ? "https" : "http";
                    const testUrl = `${testScheme}://${domain}${path}`;
                    const matchedAll = getMatchingCookies(jar, testUrl, {
                        now,
                        excludeHostOnly: !hostOnly
                    });
                    const cookieHeader = formatCookieHeader(matchedAll);
                    const nonHttpOnlyPairs = matchedAll
                        .filter(c => !c.httpOnly)
                        .map(c => [c.name, c.value]);

                    const priority = 10
                        + (path === "/" ? 0 : path.length * 10)
                        + (hostOnly ? 5000 : domain.length * 5)
                        + (schemeMode === "https" ? 2 : (schemeMode === "http" ? 1 : 0));

                    const regexFilter = buildRegexFilter(domain, hostOnly, path, schemeMode);
                    const encodedNonHttpOnly = nonHttpOnlyPairs.length > 0
                        ? `${priority}:${toBase64UrlUtf8(JSON.stringify(nonHttpOnlyPairs))}`
                        : null;

                    specs.push({
                        priority,
                        regexFilter,
                        cookieHeader,
                        encodedNonHttpOnly
                    });
                }
            }
        }

        return specs;
    }

    const exported = {
        ALL_RESOURCE_TYPES,
        isIpAddress,
        isTrustworthyUrl,
        getDefaultPath,
        domainMatches,
        pathMatches,
        makeCookieKey,
        parseCookieString,
        applyCookieToJar,
        pruneExpiredCookies,
        getMatchingCookies,
        formatCookieHeader,
        buildCookieDnrSpecs,
        toBase64UrlUtf8
    };

    if (typeof module !== "undefined" && module.exports) {
        module.exports = exported;
    } else {
        root.PwnFoxCookies = exported;
    }
})(typeof globalThis !== "undefined" ? globalThis : this);
