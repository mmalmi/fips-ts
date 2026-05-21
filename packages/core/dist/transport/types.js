export function transportAddressKey(a) {
    return `${a.transport}:${a.addr}`;
}
export const noopLogger = {
    debug: () => { },
    info: () => { },
    warn: () => { },
    error: () => { },
};
//# sourceMappingURL=types.js.map