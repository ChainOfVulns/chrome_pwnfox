async function renderContainers() {
    const status = await chrome.runtime.sendMessage({ type: "GET_STATUS" });
    const list = document.getElementById("container-list");
    list.replaceChildren();
    if (!status) return;

    for (const color of CONTAINER_COLORS) {
        const li = document.createElement("li");
        li.className = "container-item";

        const info = document.createElement("div");
        info.className = "container-info";

        const swatch = document.createElement("span");
        swatch.className = `swatch ${color}`;
        info.appendChild(swatch);

        const name = document.createElement("strong");
        name.textContent = `PwnFox-${color}`;
        info.appendChild(name);

        const meta = document.createElement("span");
        meta.className = "meta";
        const tabs = status.tabCounts?.[color] || 0;
        const cookies = status.cookieCounts?.[color] || 0;
        meta.textContent = `${tabs} tab(s), ${cookies} cookie(s)`;
        info.appendChild(meta);

        const clearBtn = document.createElement("button");
        clearBtn.type = "button";
        clearBtn.textContent = "Clear";
        clearBtn.addEventListener("click", async () => {
            await chrome.runtime.sendMessage({ type: "CLEAR_CONTAINER", color });
            await renderContainers();
        });

        li.appendChild(info);
        li.appendChild(clearBtn);
        list.appendChild(li);
    }
}

async function main() {
    const hostEl = document.getElementById("burphost");
    const portEl = document.getElementById("burpport");
    const statusEl = document.getElementById("save-status");

    hostEl.value = await config.get("burpProxyHost");
    portEl.value = await config.get("burpProxyPort");

    document.getElementById("settings-form").addEventListener("submit", async (ev) => {
        ev.preventDefault();
        const host = hostEl.value.trim();
        const portNum = parseInt(portEl.value.trim(), 10);

        if (!host) {
            statusEl.textContent = "Host cannot be empty.";
            statusEl.className = "status error";
            return;
        }
        if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
            statusEl.textContent = "Port must be between 1 and 65535.";
            statusEl.className = "status error";
            return;
        }

        await config.set("burpProxyHost", host);
        await config.set("burpProxyPort", String(portNum));
        statusEl.textContent = "Saved!";
        statusEl.className = "status";
        setTimeout(() => {
            if (statusEl.textContent === "Saved!") statusEl.textContent = "";
        }, 2500);
    });

    document.getElementById("clear-all").addEventListener("click", async () => {
        await chrome.runtime.sendMessage({ type: "CLEAR_ALL_CONTAINERS" });
        await renderContainers();
    });

    await renderContainers();
}

document.addEventListener("DOMContentLoaded", main);
