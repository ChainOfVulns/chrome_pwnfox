const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { chromium } = require("playwright");

const EXT_DIR = path.resolve(__dirname, "..");

function startAppServer() {
    const server = http.createServer((req, res) => {
        const u = new URL(req.url, "http://127.0.0.1");
        if (u.pathname === "/favicon.ico") {
            res.writeHead(204);
            res.end();
            return;
        }
        if (u.pathname === "/login") {
            const user = u.searchParams.get("user") || "anon";
            res.writeHead(200, {
                "Content-Type": "text/html",
                "Set-Cookie": [
                    `sid=${user}_secret; Path=/; HttpOnly`,
                    `csrf=${user}_csrf; Path=/`
                ]
            });
            res.end(`<h1 id="u">${user}</h1><a id="blank-link" href="/whoami" target="_blank">Open</a>`);
            return;
        }
        if (u.pathname === "/redir-login") {
            const user = u.searchParams.get("user") || "redir";
            res.writeHead(302, {
                "Set-Cookie": `redir_sid=${user}_redir; Path=/; HttpOnly`,
                "Location": "/whoami"
            });
            res.end();
            return;
        }
        if (u.pathname === "/whoami") {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({
                cookie: req.headers["cookie"] || null,
                pwnfoxColor: req.headers["x-pwnfox-color"] || null
            }));
            return;
        }
        if (u.pathname === "/app") {
            res.writeHead(200, { "Content-Type": "text/html" });
            res.end(`<!DOCTYPE html><html><head><script>
                window.__BOOT__ = {
                    cookie: document.cookie,
                    lsToken: localStorage.getItem("token")
                };
            </script></head><body><div id='app'>App</div><iframe id="sub" src="/whoami"></iframe><iframe id="sd" srcdoc="<script>window.parent.__SRCDOC_LS__ = localStorage.getItem('token');</script>"></iframe></body></html>`);
            return;
        }
        if (u.pathname === "/multipath/sub") {
            res.writeHead(200, {
                "Content-Type": "text/html",
                "Set-Cookie": [
                    "dup=root_val; Path=/",
                    "dup=sub_val; Path=/multipath"
                ]
            });
            res.end("multipath");
            return;
        }
        if (u.pathname === "/set-parent") {
            res.writeHead(200, {
                "Content-Type": "text/html",
                "Set-Cookie": "shared=parent_val; Domain=localhost; Path=/"
            });
            res.end("parent-set");
            return;
        }
        if (u.pathname === "/step2-cookie") {
            res.writeHead(200, {
                "Content-Type": "text/html",
                "Set-Cookie": "step2_csrf=added_on_200; Path=/"
            });
            res.end("step2");
            return;
        }
        if (u.pathname === "/shared-worker.js") {
            res.writeHead(200, { "Content-Type": "application/javascript" });
            res.end(`
                let count = 0;
                onconnect = (e) => {
                    const port = e.ports[0];
                    port.onmessage = (ev) => {
                        if (ev.data === "inc") count++;
                        port.postMessage(count);
                    };
                };
            `);
            return;
        }
        res.writeHead(404);
        res.end("not found");
    });

    return new Promise((resolve) => {
        server.listen(0, "127.0.0.1", () => {
            resolve({ server, port: server.address().port });
        });
    });
}

function startMockBurpProxy() {
    const proxiedRequests = [];
    const agent = new http.Agent({ keepAlive: false });
    const server = http.createServer((clientReq, clientRes) => {
        proxiedRequests.push({
            url: clientReq.url,
            pwnfoxColor: clientReq.headers["x-pwnfox-color"] || null,
            cookie: clientReq.headers["cookie"] || null
        });

        const targetUrl = new URL(clientReq.url);
        const hostname = (targetUrl.hostname === "localhost" || targetUrl.hostname.endsWith(".localhost"))
            ? "127.0.0.1"
            : targetUrl.hostname;
        const proxyReq = http.request({
            hostname,
            port: targetUrl.port || 80,
            path: targetUrl.pathname + targetUrl.search,
            method: clientReq.method,
            headers: clientReq.headers,
            agent
        }, (proxyRes) => {
            clientRes.writeHead(proxyRes.statusCode, proxyRes.headers);
            proxyRes.pipe(clientRes);
        });
        clientReq.on("aborted", () => proxyReq.destroy());
        proxyReq.on("error", (err) => {
            if (!clientRes.headersSent) {
                clientRes.writeHead(502);
                clientRes.end(String(err));
            } else {
                clientRes.destroy(err);
            }
        });
        clientReq.pipe(proxyReq);
    });

    return new Promise((resolve) => {
        server.listen(0, "127.0.0.1", () => {
            resolve({ server, agent, port: server.address().port, proxiedRequests });
        });
    });
}

async function openExtensionPopup(ctx, extensionId) {
    const page = await ctx.newPage();
    await page.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);
    await page.waitForSelector("#identities .identity.blue");
    return page;
}

async function openContainerTab(ctx, sw, color, url) {
    const newPagePromise = ctx.waitForEvent("page");
    await sw.evaluate(async (c) => {
        await createContainerTab(c);
    }, color);
    const page = await newPagePromise;
    if (url) {
        await page.goto(url);
    }
    return page;
}

test("E2E: Container isolation, Burp proxy, X-PwnFox-Color, redirects, opener inheritance, clear, UI", async () => {
    const userDir = fs.mkdtempSync(path.join(os.tmpdir(), "pf-e2e-"));
    const app = await startAppServer();
    const proxy = await startMockBurpProxy();
    const baseUrl = `http://127.0.0.1:${app.port}`;

    let ctx;
    try {
        ctx = await chromium.launchPersistentContext(userDir, {
            channel: "chromium",
            headless: false,
            args: [
                "--headless=new",
                `--disable-extensions-except=${EXT_DIR}`,
                `--load-extension=${EXT_DIR}`
            ]
        });

        let [sw] = ctx.serviceWorkers();
        if (!sw) sw = await ctx.waitForEvent("serviceworker", { timeout: 10000 });
        await sw.evaluate(() => ensureInitialized());
        const extensionId = new URL(sw.url()).host;

        // 1. Popup & Settings UI test
        const settingsPage = await ctx.newPage();
        const settingsErrors = [];
        settingsPage.on("pageerror", e => settingsErrors.push(String(e)));
        await settingsPage.goto(`chrome-extension://${extensionId}/src/settings/index.html`);
        await settingsPage.fill("#burphost", "127.0.0.1");
        await settingsPage.fill("#burpport", String(proxy.port));
        await settingsPage.click("#save");
        await settingsPage.waitForFunction(() => document.getElementById("save-status").textContent === "Saved!");
        assert.deepEqual(settingsErrors, []);
        await settingsPage.close();

        const popupPage = await openExtensionPopup(ctx, extensionId);
        const popupErrors = [];
        popupPage.on("pageerror", e => popupErrors.push(String(e)));
        await popupPage.click("#option-enabled");
        await popupPage.click("#option-useBurpProxy");
        // Verify popup displays updated proxy address
        await popupPage.waitForFunction((p) => document.getElementById("proxy-addr").textContent.includes(String(p)), proxy.port);
        assert.deepEqual(popupErrors, []);
        await popupPage.close();

        // Wait briefly for proxy settings & DNR sync to settle
        await sw.evaluate(() => ensureInitialized());

        // 2. Open Blue, Red, Turquoise, and Normal tabs on the SAME origin
        const bluePage = await openContainerTab(ctx, sw, "blue", `${baseUrl}/login?user=alice`);
        const redPage = await openContainerTab(ctx, sw, "red", `${baseUrl}/login?user=bob`);
        const turqPage = await openContainerTab(ctx, sw, "turquoise", `${baseUrl}/login?user=carol`);
        const normalPage = await ctx.newPage();
        await normalPage.goto(`${baseUrl}/login?user=charlie`);

        // Verify Server-Timing was hidden from page JS
        const stVisible = await bluePage.evaluate(() =>
            performance.getEntriesByType("navigation")[0].serverTiming.map(s => s.name)
        );
        assert.equal(stVisible.includes("pwnfox"), false);
        assert.equal(stVisible.includes("pwnfox-ck"), false);

        // 3. Populate localStorage, sessionStorage, IndexedDB, CacheStorage in each tab
        const setupClientState = async (page, who) => {
            await page.evaluate(async (w) => {
                localStorage.setItem("token", `${w}_ls`);
                localStorage[`prop_${w}`] = "yes";
                sessionStorage.setItem("ss_user", `${w}_ss`);
                await new Promise((resolve, reject) => {
                    const req = indexedDB.open("authdb", 1);
                    req.onupgradeneeded = () => req.result.createObjectStore("kv");
                    req.onsuccess = () => {
                        const tx = req.result.transaction("kv", "readwrite");
                        tx.objectStore("kv").put({ user: w }, "me");
                        tx.oncomplete = () => { req.result.close(); resolve(); };
                    };
                    req.onerror = () => reject(req.error);
                });
                const cache = await caches.open("v1");
                await cache.put("/me", new Response(w));
            }, who);
        };

        await setupClientState(bluePage, "alice");
        await setupClientState(redPage, "bob");
        await setupClientState(normalPage, "charlie");

        // 4. Reload Blue & Red and verify complete isolation across HTTP, document.cookie, localStorage, sessionStorage, IDB, Caches
        await bluePage.reload();
        await redPage.reload();
        await normalPage.reload();

        const inspectTab = async (page) => {
            return await page.evaluate(async () => {
                const whoami = await (await fetch("/whoami")).json();
                const idbVal = await new Promise((resolve) => {
                    const req = indexedDB.open("authdb", 1);
                    req.onsuccess = () => {
                        const tx = req.result.transaction("kv", "readonly");
                        const g = tx.objectStore("kv").get("me");
                        g.onsuccess = () => { req.result.close(); resolve(g.result); };
                    };
                });
                const dbList = await indexedDB.databases();
                const cacheHit = await (await caches.match("/me"))?.text();
                const cacheKeys = await caches.keys();
                return {
                    whoami,
                    docCookie: document.cookie,
                    lsToken: localStorage.getItem("token"),
                    lsKeys: Object.keys(localStorage),
                    ssUser: sessionStorage.getItem("ss_user"),
                    idbVal,
                    dbNames: dbList.map(d => d.name),
                    cacheHit,
                    cacheKeys
                };
            });
        };

        const blueState = await inspectTab(bluePage);
        const redState = await inspectTab(redPage);
        const normalState = await inspectTab(normalPage);

        assert.equal(blueState.whoami.cookie, "sid=alice_secret; csrf=alice_csrf");
        assert.equal(blueState.whoami.pwnfoxColor, "blue");
        assert.equal(blueState.docCookie, "csrf=alice_csrf");
        assert.equal(blueState.lsToken, "alice_ls");
        assert.deepEqual(blueState.lsKeys.sort(), ["prop_alice", "token"]);
        assert.equal(blueState.ssUser, "alice_ss");
        assert.deepEqual(blueState.idbVal, { user: "alice" });
        assert.deepEqual(blueState.dbNames, ["authdb"]);
        assert.equal(blueState.cacheHit, "alice");
        assert.deepEqual(blueState.cacheKeys, ["v1"]);

        assert.equal(redState.whoami.cookie, "sid=bob_secret; csrf=bob_csrf");
        assert.equal(redState.whoami.pwnfoxColor, "red");
        assert.equal(redState.docCookie, "csrf=bob_csrf");
        assert.equal(redState.lsToken, "bob_ls");
        assert.deepEqual(redState.lsKeys.sort(), ["prop_bob", "token"]);
        assert.equal(redState.ssUser, "bob_ss");
        assert.deepEqual(redState.idbVal, { user: "bob" });
        assert.deepEqual(redState.dbNames, ["authdb"]);
        assert.equal(redState.cacheHit, "bob");
        assert.deepEqual(redState.cacheKeys, ["v1"]);

        assert.equal(normalState.whoami.cookie, "sid=charlie_secret; csrf=charlie_csrf");
        assert.equal(normalState.whoami.pwnfoxColor, null);
        assert.equal(normalState.lsToken, "charlie_ls");
        assert.deepEqual(normalState.lsKeys.sort(), ["prop_charlie", "token"]);

        // Normal tab localStorage.clear() must NOT wipe Blue or Red!
        await normalPage.evaluate(() => localStorage.clear());
        assert.equal(await bluePage.evaluate(() => localStorage.getItem("token")), "alice_ls");
        assert.equal(await redPage.evaluate(() => localStorage.getItem("token")), "bob_ls");

        // 5. BroadcastChannel isolation between Blue & Red
        await bluePage.evaluate(() => {
            window.__bcMsg = [];
            const bc = new BroadcastChannel("auth");
            bc.onmessage = (e) => window.__bcMsg.push(e.data);
        });
        await redPage.evaluate(() => {
            const bc = new BroadcastChannel("auth");
            bc.postMessage("red_logout");
        });
        await bluePage.waitForTimeout(50);
        assert.deepEqual(await bluePage.evaluate(() => window.__bcMsg), []);

        // 6. document.cookie -> immediate fetch() sync
        const afterDocCookieFetch = await bluePage.evaluate(async () => {
            document.cookie = "client_tok=blue999; Path=/";
            return await (await fetch("/whoami")).json();
        });
        assert.ok(afterDocCookieFetch.cookie.includes("client_tok=blue999"));
        // Red must NOT see client_tok
        const redCheck = await redPage.evaluate(async () => await (await fetch("/whoami")).json());
        assert.equal(redCheck.cookie.includes("client_tok"), false);

        // 7. 302 redirect with Set-Cookie inside Blue container
        await bluePage.goto(`${baseUrl}/redir-login?user=alice`).catch(() => {});
        await bluePage.waitForFunction(
            () => document.body && document.body.innerText.includes("redir_sid=alice_redir"),
            null,
            { timeout: 3000 }
        );
        const redirBody = JSON.parse(await bluePage.evaluate(() => document.body.innerText));
        assert.ok(redirBody.cookie.includes("redir_sid=alice_redir"));
        assert.equal(redirBody.pwnfoxColor, "blue");

        // 8. Opener / target="_blank" tab inherits Blue container
        await bluePage.goto(`${baseUrl}/login?user=alice`);
        const [popupTab] = await Promise.all([
            ctx.waitForEvent("page"),
            bluePage.click("#blank-link")
        ]);
        await popupTab.waitForLoadState("load");
        const popupWhoami = JSON.parse(await popupTab.evaluate(() => document.body.innerText));
        assert.ok(popupWhoami.cookie.includes("sid=alice_secret"));
        assert.equal(popupWhoami.pwnfoxColor, "blue");
        await popupTab.close();

        // 9. Turquoise maps to X-PwnFox-Color: cyan, and traffic went through Mock Burp Proxy!
        const turqWhoami = await turqPage.evaluate(async () => await (await fetch("/whoami")).json());
        assert.equal(turqWhoami.pwnfoxColor, "cyan");
        assert.ok(proxy.proxiedRequests.some(r => r.url.includes("/whoami") && r.pwnfoxColor === "blue"));
        assert.ok(proxy.proxiedRequests.some(r => r.url.includes("/whoami") && r.pwnfoxColor === "cyan"));

        // 10. Toggle addContainerHeader = false, then enabled = false (proxy stops, isolation remains!)
        await sw.evaluate(async () => { await config.set("addContainerHeader", false); });
        await sw.evaluate(() => new Promise(r => setTimeout(r, 80)));
        const noHeaderWhoami = await bluePage.evaluate(async () => await (await fetch("/whoami")).json());
        assert.equal(noHeaderWhoami.pwnfoxColor, null);
        assert.ok(noHeaderWhoami.cookie.includes("sid=alice_secret"));

        await sw.evaluate(async () => { await config.set("enabled", false); });
        await sw.evaluate(() => new Promise(r => setTimeout(r, 80)));
        const countBefore = proxy.proxiedRequests.length;
        const disabledBlue = await bluePage.evaluate(async () => await (await fetch("/whoami")).json());
        assert.equal(proxy.proxiedRequests.length, countBefore, "Proxy should not receive traffic when disabled");
        assert.ok(disabledBlue.cookie.includes("sid=alice_secret"), "Containers remain isolated when PwnFox proxy toggle is off");

        // 11. Clear Blue container -> Blue wiped (both live and after reload), Red untouched
        await bluePage.goto(`${baseUrl}/app`);
        await sw.evaluate(async () => { await clearContainer("blue"); });
        // Give live tab message a brief tick to settle, then verify both live & post-reload
        await bluePage.waitForFunction(() => document.cookie === "" && localStorage.getItem("token") === null);
        await bluePage.reload();
        const clearedBlue = await bluePage.evaluate(async () => ({
            whoami: await (await fetch("/whoami")).json(),
            docCookie: document.cookie,
            lsToken: localStorage.getItem("token"),
            dbNames: (await indexedDB.databases()).map(d => d.name),
            cacheKeys: await caches.keys()
        }));
        assert.equal(clearedBlue.whoami.cookie, null);
        assert.equal(clearedBlue.docCookie, "");
        assert.equal(clearedBlue.lsToken, null);
        assert.deepEqual(clearedBlue.dbNames, []);
        assert.deepEqual(clearedBlue.cacheKeys, []);

        // Red is untouched!
        const redStillAlive = await redPage.evaluate(async () => ({
            whoami: await (await fetch("/whoami")).json(),
            lsToken: localStorage.getItem("token")
        }));
        assert.equal(redStillAlive.whoami.cookie, "sid=bob_secret; csrf=bob_csrf");
        assert.equal(redStillAlive.lsToken, "bob_ls");

        // 12. Inline <head> script at document_start, iframe, srcdoc, XHR sync, and popup container button (purple -> magenta)
        await sw.evaluate(async () => { await config.set("enabled", true); await config.set("addContainerHeader", true); });
        await sw.evaluate(() => new Promise(r => setTimeout(r, 80)));

        await redPage.goto(`${baseUrl}/app`);
        const bootCheck = await redPage.evaluate(async () => {
            const subFrame = document.getElementById("sub");
            const subWhoami = JSON.parse(subFrame.contentDocument.body.innerText);

            // XHR immediately after document.cookie
            document.cookie = "xhr_tok=bob_xhr; Path=/";
            const xhrResp = await new Promise((resolve) => {
                const xhr = new XMLHttpRequest();
                xhr.open("GET", "/whoami");
                xhr.onload = () => resolve(JSON.parse(xhr.responseText));
                xhr.send();
            });
            return {
                boot: window.__BOOT__,
                srcdocLs: window.__SRCDOC_LS__,
                subWhoami,
                xhrResp
            };
        });
        assert.equal(bootCheck.boot.cookie, "csrf=bob_csrf");
        assert.equal(bootCheck.boot.lsToken, "bob_ls");
        assert.equal(bootCheck.srcdocLs, "bob_ls");
        assert.equal(bootCheck.subWhoami.cookie, "sid=bob_secret; csrf=bob_csrf");
        assert.equal(bootCheck.subWhoami.pwnfoxColor, "red");
        assert.ok(bootCheck.xhrResp.cookie.includes("xhr_tok=bob_xhr"));

        // Click purple button directly in Popup UI -> opens container tab with X-PwnFox-Color: magenta
        const popupForPurple = await openExtensionPopup(ctx, extensionId);
        const [purplePage] = await Promise.all([
            ctx.waitForEvent("page"),
            popupForPurple.click("#identities .identity.purple")
        ]);
        await purplePage.goto(`${baseUrl}/whoami`);
        const purpleWhoami = JSON.parse(await purplePage.evaluate(() => document.body.innerText));
        assert.equal(purpleWhoami.pwnfoxColor, "magenta");
        assert.equal(purpleWhoami.cookie, null);

        // 13. Cross-origin iframe isolation, multi-path same-name cookies, Storage instanceof, rapid writes, subdomain sync
        // Note: Turn off Burp proxy temporarily for direct localhost subdomain tests or keep it on (mock proxy handles URLs)
        const orangePage = await openContainerTab(ctx, sw, "orange", `${baseUrl}/multipath/sub`);
        const multiCheck = await orangePage.evaluate(async () => {
            const multiDoc = document.cookie;
            const storageProtoOk = (localStorage instanceof Storage) && (sessionStorage instanceof Storage);
            document.cookie = "seq1=v1; Path=/";
            document.cookie = "seq2=v2; Path=/";
            const seqDoc = document.cookie;
            const seqWhoami = await (await fetch("/whoami")).json();
            return { multiDoc, storageProtoOk, seqDoc, seqWhoami };
        });
        assert.equal(multiCheck.multiDoc, "dup=sub_val; dup=root_val");
        assert.equal(multiCheck.storageProtoOk, true);
        assert.ok(multiCheck.seqDoc.includes("seq1=v1") && multiCheck.seqDoc.includes("seq2=v2"));
        assert.ok(multiCheck.seqWhoami.cookie.includes("seq1=v1") && multiCheck.seqWhoami.cookie.includes("seq2=v2"));

        // Cross-origin iframe (http://localhost inside http://127.0.0.1) must NOT be overwritten by top-frame COOKIES_UPDATED
        await orangePage.evaluate((p) => {
            const f = document.createElement("iframe");
            f.id = "xorigin";
            f.src = `http://localhost:${p}/app`;
            document.body.appendChild(f);
        }, app.port);
        await orangePage.frameLocator("#xorigin").locator("#app").waitFor();
        const xOriginFrame = orangePage.frames().find(f => f.url().includes(`localhost:${app.port}/app`));
        await xOriginFrame.evaluate(() => { document.cookie = "xo_tok=localhost_only; Path=/"; });
        await orangePage.waitForTimeout(50);
        await orangePage.evaluate(() => { document.cookie = "top_only=ip_only; Path=/"; });
        await orangePage.waitForTimeout(80);
        assert.equal(await xOriginFrame.evaluate(() => document.cookie), "xo_tok=localhost_only");

        // Subdomain cookie sharing within same container (sub1.localhost -> sub2.localhost) and isolation from pink container
        const sub1Orange = await openContainerTab(ctx, sw, "orange", `http://sub1.localhost:${app.port}/set-parent`);
        const sub2Orange = await openContainerTab(ctx, sw, "orange", `http://sub2.localhost:${app.port}/whoami`);
        const sub2Pink = await openContainerTab(ctx, sw, "pink", `http://sub2.localhost:${app.port}/whoami`);
        assert.equal(JSON.parse(await sub2Orange.evaluate(() => document.body.innerText)).cookie, "shared=parent_val");
        assert.equal(JSON.parse(await sub2Pink.evaluate(() => document.body.innerText)).cookie, null);
        await sub1Orange.evaluate(() => { document.cookie = "js_sub=ok; Domain=localhost; Path=/"; });
        await sub2Orange.waitForFunction(() => document.cookie.includes("js_sub=ok"));
        assert.equal(await sub2Pink.evaluate(() => document.cookie), "");

        // 14. Regression checks:
        // (a) localStorage Object.prototype methods (hasOwnProperty, toString)
        // (b) window.onstorage must NOT leak across containers
        // (c) INIT_CONTEXT updates document.cookie on 200 Set-Cookie even when container already has cookies
        // (d) SharedWorker and concurrent container tab grouping isolation
        await bluePage.goto(`${baseUrl}/login?user=alice_re`);
        await bluePage.goto(`${baseUrl}/step2-cookie`);
        await bluePage.waitForFunction(() => document.cookie.includes("step2_csrf=added_on_200"));

        const lsProtoCheck = await bluePage.evaluate(() => {
            localStorage.setItem("proto_k", "v");
            return {
                hasOwn: localStorage.hasOwnProperty("proto_k"),
                hasOther: localStorage.hasOwnProperty("missing_k"),
                str: "" + localStorage
            };
        });
        assert.equal(lsProtoCheck.hasOwn, true);
        assert.equal(lsProtoCheck.hasOther, false);
        assert.equal(lsProtoCheck.str, "[object Storage]");

        await redPage.goto(`${baseUrl}/app`);
        await redPage.evaluate(() => {
            window.__onStorageLeaks = [];
            window.onstorage = (ev) => window.__onStorageLeaks.push({ key: ev.key, val: ev.newValue });
        });
        await bluePage.evaluate(() => localStorage.setItem("leak_probe", "secret_blue"));
        await redPage.waitForTimeout(80);
        assert.deepEqual(await redPage.evaluate(() => window.__onStorageLeaks), []);

        const blueSwCount = await bluePage.evaluate(() => new Promise((resolve) => {
            const w = new SharedWorker("/shared-worker.js");
            w.port.onmessage = (e) => resolve(e.data);
            w.port.postMessage("inc");
        }));
        const redSwCount = await redPage.evaluate(() => new Promise((resolve) => {
            const w = new SharedWorker("/shared-worker.js");
            w.port.onmessage = (e) => resolve(e.data);
            w.port.postMessage("inc");
        }));
        assert.equal(blueSwCount, 1);
        assert.equal(redSwCount, 1);

        // Concurrent createContainerTab for yellow must create exactly one PwnFox-yellow tab group
        const yellowPagesPromise = Promise.all([
            ctx.waitForEvent("page"),
            ctx.waitForEvent("page")
        ]);
        await sw.evaluate(() => Promise.all([createContainerTab("yellow"), createContainerTab("yellow")]));
        await yellowPagesPromise;
        const yellowGroups = await sw.evaluate(() => chrome.tabGroups.query({ title: "PwnFox-yellow" }));
        assert.equal(yellowGroups.length, 1);
    } finally {
        if (ctx) await ctx.close().catch(() => {});
        app.server.closeAllConnections?.();
        app.server.close();
        proxy.agent?.destroy();
        proxy.server.closeAllConnections?.();
        proxy.server.close();
        fs.rmSync(userDir, { recursive: true, force: true });
    }
});

test("E2E: Container session persists across browser restart via Tab Group recovery", async () => {
    const userDir = fs.mkdtempSync(path.join(os.tmpdir(), "pf-persist-"));
    const app = await startAppServer();
    const baseUrl = `http://127.0.0.1:${app.port}`;

    let ctx;
    try {
        // Session 1: login in green container
        ctx = await chromium.launchPersistentContext(userDir, {
            channel: "chromium",
            headless: false,
            args: [
                "--headless=new",
                `--disable-extensions-except=${EXT_DIR}`,
                `--load-extension=${EXT_DIR}`
            ]
        });
        let [sw] = ctx.serviceWorkers();
        if (!sw) sw = await ctx.waitForEvent("serviceworker", { timeout: 10000 });
        await sw.evaluate(() => ensureInitialized());

        const greenPage = await openContainerTab(ctx, sw, "green", `${baseUrl}/login?user=green_u`);
        await greenPage.evaluate(() => localStorage.setItem("persist_k", "green_val"));
        await sw.evaluate(() => flushPersist());
        await ctx.close();
        ctx = null;

        // Session 2: reopen browser with same profile, open a green tab and verify cookies + localStorage persisted
        ctx = await chromium.launchPersistentContext(userDir, {
            channel: "chromium",
            headless: false,
            args: [
                "--headless=new",
                `--disable-extensions-except=${EXT_DIR}`,
                `--load-extension=${EXT_DIR}`
            ]
        });
        [sw] = ctx.serviceWorkers();
        if (!sw) sw = await ctx.waitForEvent("serviceworker", { timeout: 10000 });
        await sw.evaluate(() => ensureInitialized());

        const greenPage2 = await openContainerTab(ctx, sw, "green", `${baseUrl}/whoami`);
        const whoami2 = JSON.parse(await greenPage2.evaluate(() => document.body.innerText));
        assert.equal(whoami2.cookie, "sid=green_u_secret; csrf=green_u_csrf");
        await greenPage2.goto(`${baseUrl}/app`);
        assert.equal(await greenPage2.evaluate(() => window.__BOOT__.lsToken), null);
        assert.equal(await greenPage2.evaluate(() => localStorage.getItem("persist_k")), "green_val");

        await ctx.close();
        ctx = null;
    } finally {
        if (ctx) await ctx.close().catch(() => {});
        app.server.closeAllConnections?.();
        app.server.close();
        fs.rmSync(userDir, { recursive: true, force: true });
    }
});
