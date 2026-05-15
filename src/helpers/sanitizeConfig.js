/**
 * Strip credentials and other sensitive fields before logging a config object.
 * Returns a shallow clone — never mutates the input.
 *
 * Masks proxy URLs of the form `http://user:pass@host:port` to `http://***:***@host:port`.
 * Leaves a proxy URL with no credentials untouched.
 */
function maskProxyUrl(value) {
    if (typeof value !== 'string' || value.length === 0) return value;
    return value.replace(
        /^(\w+:\/\/)([^:@\s\/]+):([^@\s\/]+)@/g,
        (_, scheme) => `${scheme}***:***@`
    );
}

function sanitizeConfigForLog(config) {
    if (!config || typeof config !== 'object') return config;
    const clone = { ...config };
    if (typeof clone.proxyUrl === 'string') {
        clone.proxyUrl = clone.proxyUrl
            .split(/\r?\n/)
            .map(maskProxyUrl)
            .join('\n');
    }
    return clone;
}

module.exports = { sanitizeConfigForLog, maskProxyUrl };
