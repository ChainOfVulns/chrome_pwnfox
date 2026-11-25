const test = require("node:test");
const assert = require("node:assert/strict");
const cookies = require("../src/cookies.js");

test("parseCookieString parses Set-Cookie attributes and handles value with '='", () => {
    const now = 1_700_000_000_000;
    const c = cookies.parseCookieString(
        "session=abc=123==; Domain=.example.com; Path=/app; Max-Age=60; HttpOnly; Secure; SameSite=Strict",
        "https://sub.example.com/app/login",
        { now }
    );
    assert.ok(c);
    assert.equal(c.name, "session");
    assert.equal(c.value, "abc=123==");
    assert.equal(c.domain, "example.com");
    assert.equal(c.hostOnly, false);
    assert.equal(c.path, "/app");
    assert.equal(c.httpOnly, true);
    assert.equal(c.secure, true);
    assert.equal(c.sameSite, "Strict");
    assert.equal(c.expiresAt, now + 60_000);
});

test("parseCookieString rejects mismatched Domain and enforces __Host- / __Secure-", () => {
    const badDomain = cookies.parseCookieString(
        "a=1; Domain=other.com",
        "https://app.example.com/"
    );
    assert.equal(badDomain, null);

    const badSecurePrefix = cookies.parseCookieString(
        "__Secure-id=1; Secure",
        "http://example.com/"
    );
    assert.equal(badSecurePrefix, null);

    const badHostPrefixDomain = cookies.parseCookieString(
        "__Host-id=1; Secure; Domain=example.com; Path=/",
        "https://example.com/"
    );
    assert.equal(badHostPrefixDomain, null);

    const goodHostPrefix = cookies.parseCookieString(
        "__Host-id=1; Secure; Path=/",
        "https://example.com/login"
    );
    assert.ok(goodHostPrefix);
    assert.equal(goodHostPrefix.hostOnly, true);
});

test("document.cookie cannot set or overwrite HttpOnly cookies", () => {
    const jar = {};
    const serverCookie = cookies.parseCookieString(
        "sid=secret; Path=/; HttpOnly",
        "https://app.example.com/"
    );
    assert.equal(cookies.applyCookieToJar(jar, serverCookie), true);

    // JS tries to set HttpOnly cookie -> rejected
    const jsHttpOnly = cookies.parseCookieString(
        "x=1; HttpOnly",
        "https://app.example.com/",
        { fromDocumentCookie: true }
    );
    assert.equal(jsHttpOnly, null);

    const jsHttpOnlyWithVal = cookies.parseCookieString(
        "x=1; HttpOnly=true",
        "https://app.example.com/",
        { fromDocumentCookie: true }
    );
    assert.equal(jsHttpOnlyWithVal, null);

    // JS tries to overwrite existing HttpOnly cookie 'sid' -> rejected
    const jsOverwrite = cookies.parseCookieString(
        "sid=hacked; Path=/",
        "https://app.example.com/",
        { fromDocumentCookie: true }
    );
    assert.equal(cookies.applyCookieToJar(jar, jsOverwrite, { fromDocumentCookie: true }), false);
    assert.equal(jar[cookies.makeCookieKey(serverCookie)].value, "secret");
});

test("path matching and deletion via Max-Age=0", () => {
    const now = 1_700_000_000_000;
    const jar = {};
    const c1 = cookies.parseCookieString("a=1; Path=/", "https://example.com/", { now });
    const c2 = cookies.parseCookieString("b=2; Path=/admin", "https://example.com/admin/panel", { now });
    cookies.applyCookieToJar(jar, c1, { now });
    cookies.applyCookieToJar(jar, c2, { now });

    const rootMatches = cookies.getMatchingCookies(jar, "https://example.com/admin2", { now });
    assert.deepEqual(rootMatches.map(c => c.name), ["a"]);

    const adminMatches = cookies.getMatchingCookies(jar, "https://example.com/admin/users", { now });
    assert.deepEqual(adminMatches.map(c => c.name), ["b", "a"]);

    // Delete 'b'
    const delB = cookies.parseCookieString("b=; Path=/admin; Max-Age=0", "https://example.com/", { now });
    assert.equal(cookies.applyCookieToJar(jar, delB, { now }), true);
    const afterDel = cookies.getMatchingCookies(jar, "https://example.com/admin/users", { now });
    assert.deepEqual(afterDel.map(c => c.name), ["a"]);
});

test("buildCookieDnrSpecs merges parent/subdomain/path cookies and excludes HttpOnly from Server-Timing payload", () => {
    const now = 1_700_000_000_000;
    const jar = {};
    cookies.applyCookieToJar(jar, cookies.parseCookieString("root=1; Domain=example.com; Path=/; HttpOnly", "https://app.example.com/", { now }), { now });
    cookies.applyCookieToJar(jar, cookies.parseCookieString("csrf=xyz; Path=/", "https://app.example.com/", { now }), { now });
    cookies.applyCookieToJar(jar, cookies.parseCookieString("adm=9; Path=/admin", "https://app.example.com/admin", { now }), { now });

    const specs = cookies.buildCookieDnrSpecs(jar, now);
    const appAdmin = specs.find(s => s.cookieHeader.includes("adm=9"));
    assert.ok(appAdmin);
    assert.ok(appAdmin.cookieHeader.includes("root=1"));
    assert.ok(appAdmin.cookieHeader.includes("csrf=xyz"));
    assert.ok(new RegExp(appAdmin.regexFilter).test("https://app.example.com/admin/settings"));
    assert.equal(new RegExp(appAdmin.regexFilter).test("https://app.example.com/admin2"), false);

    // Decode Server-Timing payload and verify HttpOnly 'root' is NOT exposed
    const [, b64] = appAdmin.encodedNonHttpOnly.split(":");
    const jsonStr = Buffer.from(b64, "base64url").toString("utf8");
    const pairs = JSON.parse(jsonStr);
    assert.deepEqual(pairs, [["adm", "9"], ["csrf", "xyz"]]);
});

test("same-millisecond Set-Cookie order persists across JSON serialization with reordered keys", () => {
    const now = 1_700_000_000_000;
    const jar = {};
    cookies.applyCookieToJar(jar, cookies.parseCookieString("sid=1; Path=/; HttpOnly", "http://127.0.0.1/", { now }), { now });
    cookies.applyCookieToJar(jar, cookies.parseCookieString("csrf=2; Path=/", "http://127.0.0.1/", { now }), { now });

    // Simulate chrome.storage.local reordering keys alphabetically on reload
    const serialized = JSON.parse(JSON.stringify(jar));
    const reordered = {};
    for (const k of Object.keys(serialized).sort()) {
        reordered[k] = serialized[k];
    }

    const matched = cookies.getMatchingCookies(reordered, "http://127.0.0.1/whoami", { now });
    assert.equal(cookies.formatCookieHeader(matched), "sid=1; csrf=2");
});

test("parseCookieString rejects invalid cookie names and control characters in values", () => {
    assert.equal(cookies.parseCookieString("bad name=1; Path=/", "https://example.com/"), null);
    assert.equal(cookies.parseCookieString("bad;name=1; Path=/", "https://example.com/"), null);
    assert.equal(cookies.parseCookieString("ok=bad\r\nval; Path=/", "https://example.com/"), null);
    assert.equal(cookies.parseCookieString("ok=bad\x00val; Path=/", "https://example.com/"), null);
});

test("buildCookieDnrSpecs never leaks host-only cookies into wildcard Domain specs", () => {
    const now = 1_700_000_000_000;
    const jar = {};
    cookies.applyCookieToJar(jar, cookies.parseCookieString("host_only=secret; Path=/", "http://localhost/", { now }), { now });
    cookies.applyCookieToJar(jar, cookies.parseCookieString("shared=pub; Domain=localhost; Path=/", "http://sub1.localhost/", { now }), { now });

    const specs = cookies.buildCookieDnrSpecs(jar, now);
    const wildcardSpec = specs.find(s => new RegExp(s.regexFilter).test("http://sub2.localhost/whoami"));
    const exactSpec = specs.find(s => new RegExp(s.regexFilter).test("http://localhost/app") && s.priority >= 5000);

    assert.ok(wildcardSpec);
    assert.ok(exactSpec);
    assert.equal(wildcardSpec.cookieHeader, "shared=pub");
    assert.equal(wildcardSpec.cookieHeader.includes("host_only"), false);
    assert.ok(exactSpec.cookieHeader.includes("host_only=secret"));
    assert.ok(exactSpec.cookieHeader.includes("shared=pub"));
});
