async function bindCheckboxToConfig(selector, cfg, configName) {
    const checkbox = document.querySelector(selector);
    checkbox.checked = await cfg.get(configName);
    checkbox.addEventListener("change", () => cfg.set(configName, checkbox.checked));
}

function updatePopupIcon(enabled) {
    const color = enabled ? "#00ff00" : "#ff0000";
    const canvas = createIconCanvasElement(color, 48);
    const iconContainer = document.getElementById("icon");
    iconContainer.replaceChildren(canvas);

    const main = document.querySelector("main");
    if (!enabled) {
        main.classList.add("disabled");
    } else {
        main.classList.remove("disabled");
    }
}

async function refreshStatus() {
    const status = await chrome.runtime.sendMessage({ type: "GET_STATUS" });
    if (!status) return;

    const proxyAddr = document.getElementById("proxy-addr");
    proxyAddr.textContent = `(${status.config.burpProxyHost}:${status.config.burpProxyPort})`;

    const container = document.getElementById("identities");
    container.replaceChildren();

    for (const color of CONTAINER_COLORS) {
        const wrap = document.createElement("div");
        wrap.className = "identity-wrap";

        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = `identity ${color}`;
        btn.title = `Open PwnFox-${color} container tab`;
        btn.addEventListener("click", async () => {
            await chrome.runtime.sendMessage({ type: "CREATE_CONTAINER_TAB", color });
            window.close();
        });
        wrap.appendChild(btn);

        const openCount = status.tabCounts?.[color] || 0;
        if (openCount > 0) {
            const badge = document.createElement("span");
            badge.className = "identity-badge";
            badge.textContent = String(openCount);
            wrap.appendChild(badge);
        }

        const dot = document.createElement("span");
        dot.className = "identity-dot";
        if ((status.cookieCounts?.[color] || 0) > 0) {
            dot.classList.add("has-data");
            dot.title = `${status.cookieCounts[color]} stored cookie(s)`;
        }
        wrap.appendChild(dot);

        container.appendChild(wrap);
    }

    const tabStatus = document.getElementById("current-tab-status");
    const clearBtn = document.getElementById("clear-current-btn");
    if (status.activeTabColor) {
        tabStatus.replaceChildren();
        const swatch = document.createElement("span");
        swatch.className = `status-swatch identity ${status.activeTabColor}`;
        swatch.style.margin = "0";
        swatch.style.width = "10px";
        swatch.style.height = "10px";
        tabStatus.appendChild(swatch);
        tabStatus.appendChild(document.createTextNode(`Current: PwnFox-${status.activeTabColor}`));

        clearBtn.hidden = false;
        clearBtn.onclick = async () => {
            await chrome.runtime.sendMessage({
                type: "CLEAR_CONTAINER",
                color: status.activeTabColor
            });
            await refreshStatus();
        };
    } else {
        tabStatus.textContent = "Current: Default (not isolated)";
        clearBtn.hidden = true;
    }
}

async function main() {
    await bindCheckboxToConfig("#option-enabled", config, "enabled");
    await bindCheckboxToConfig("#option-useBurpProxy", config, "useBurpProxy");
    await bindCheckboxToConfig("#option-addContainerHeader", config, "addContainerHeader");

    document.querySelector("#settings").addEventListener("click", (ev) => {
        ev.preventDefault();
        chrome.runtime.openOptionsPage();
    });

    config.onChange("enabled", updatePopupIcon);
    config.onChange("burpProxyHost", refreshStatus);
    config.onChange("burpProxyPort", refreshStatus);

    updatePopupIcon(await config.get("enabled"));
    await refreshStatus();
}

window.addEventListener("load", main);
