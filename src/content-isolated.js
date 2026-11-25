(function () {
    if (globalThis.__pwnfoxIsoInitialized) return;
    globalThis.__pwnfoxIsoInitialized = true;

    const TO_MAIN_EVENT = "__pwnfox_to_main__";
    const TO_ISO_EVENT = "__pwnfox_to_iso__";

    function sendToMain(payload) {
        window.dispatchEvent(new CustomEvent(TO_MAIN_EVENT, {
            detail: JSON.stringify(payload)
        }));
    }

    window.addEventListener(TO_ISO_EVENT, (ev) => {
        let msg;
        try {
            msg = typeof ev.detail === "string" ? JSON.parse(ev.detail) : ev.detail;
        } catch {
            return;
        }
        if (!msg || typeof msg !== "object") return;

        if (msg.type === "SET_DOCUMENT_COOKIE") {
            chrome.runtime.sendMessage({
                type: "SET_DOCUMENT_COOKIE",
                cookieString: msg.cookieString,
                url: msg.url || location.href
            }).then((resp) => {
                sendToMain({
                    type: "ACK_DOCUMENT_COOKIE",
                    seq: msg.seq,
                    pairs: resp?.pairs || null
                });
            }).catch(() => {
                sendToMain({
                    type: "ACK_DOCUMENT_COOKIE",
                    seq: msg.seq,
                    pairs: null
                });
            });
        }
    });

    chrome.runtime.onMessage.addListener((msg) => {
        if (!msg || typeof msg !== "object") return;
        if (msg.type === "COOKIES_UPDATED" || msg.type === "CONTAINER_CLEARED") {
            sendToMain(msg);
        }
    });

    // Belt-and-suspenders context sync (especially for about:blank / srcdoc / edge navigations)
    chrome.runtime.sendMessage({
        type: "GET_TAB_CONTEXT",
        url: location.href
    }).then((resp) => {
        if (resp && resp.color) {
            sendToMain({
                type: "INIT_CONTEXT",
                color: resp.color,
                namespace: resp.namespace,
                pairs: resp.pairs || []
            });
        }
    }).catch(() => {});
})();
