const CONTAINER_COLORS = [
    "blue",
    "turquoise",
    "green",
    "yellow",
    "orange",
    "red",
    "pink",
    "purple"
];

const BURP_COLOR_MAP = {
    blue: "blue",
    turquoise: "cyan",
    green: "green",
    yellow: "yellow",
    orange: "orange",
    red: "red",
    pink: "pink",
    purple: "magenta"
};

const TAB_GROUP_COLOR_MAP = {
    blue: "blue",
    turquoise: "cyan",
    green: "green",
    yellow: "yellow",
    orange: "orange",
    red: "red",
    pink: "pink",
    purple: "purple"
};

const defaultConfig = {
    enabled: false,
    useBurpProxy: false,
    addContainerHeader: true,
    burpProxyHost: "127.0.0.1",
    burpProxyPort: "8080"
};

const config = {
    async get(key) {
        const r = await chrome.storage.local.get(key);
        return r[key] ?? defaultConfig[key];
    },
    async getAll() {
        const r = await chrome.storage.local.get(Object.keys(defaultConfig));
        return { ...defaultConfig, ...r };
    },
    async set(key, value) {
        return await chrome.storage.local.set({ [key]: value });
    },
    onChange(key, handler) {
        const listener = (changes, areaName) => {
            if (areaName !== "local") return;
            if (Object.prototype.hasOwnProperty.call(changes, key)) {
                handler(changes[key].newValue ?? defaultConfig[key]);
            }
        };
        chrome.storage.onChanged.addListener(listener);
        return () => chrome.storage.onChanged.removeListener(listener);
    }
};
