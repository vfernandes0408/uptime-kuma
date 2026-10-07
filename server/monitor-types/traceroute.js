const { MonitorType } = require("./monitor-type");
const { UP } = require("../../src/util");
const childProcessAsync = require("promisify-child-process");
const dns = require("dns").promises;
const net = require("net");

class TracerouteMonitorType extends MonitorType {
    name = "traceroute";

    async check(monitor, heartbeat) {
        const target = String(monitor.hostname || "").trim();
        if (!target) {
            throw new Error("Traceroute target is required");
        }

        const maxHops = this.integer(monitor.tracerouteMaxHops, 30, 1, 64);
        const probes = this.integer(monitor.tracerouteProbes, 3, 1, 5);
        const timeout = this.integer(monitor.tracerouteTimeout, 1000, 100, 10000);
        const command = monitor.tracerouteIPv6 ? "traceroute6" : "traceroute";
        const started = Date.now();
        let result;

        try {
            if (!net.isIP(target)) {
                await dns.lookup(target, { family: monitor.tracerouteIPv6 ? 6 : 4 });
            }

            result = await childProcessAsync.execFile(command, [
                "-n", "-m", String(maxHops), "-w", String(Math.max(1, Math.ceil(timeout / 1000))),
                "-q", String(probes), target,
            ], {
                timeout: Math.max(10000, timeout * maxHops + 5000),
                maxBuffer: 1024 * 1024,
            });
        } catch (error) {
            const output = [error.stdout?.toString?.() || "", error.stderr?.toString?.() || ""]
                .filter(Boolean).join("\n").trim();
            const message = this.compact(output || error.message);
            heartbeat.ping = Date.now() - started;
            heartbeat.traceroute = JSON.stringify({
                target,
                ipv6: !!monitor.tracerouteIPv6,
                error: message,
            });
            heartbeat.msg = "Traceroute failed: " + message;
            throw new Error(heartbeat.msg);
        }

        const output = result.stdout?.toString?.() || "";
        const hops = this.parse(output);
        const destinationReached = this.destinationReached(hops, target);
        const quality = this.pathQuality(hops);
        // A traceroute can be considered healthy when every observed hop responds,
        // even if the configured max-hops limit is reached before the final target.
        // This is useful for monitoring path/connectivity rather than only end-to-end reachability.
        const success = quality.totalHops > 0
            && quality.failedHops === 0
            && (destinationReached || hops.length >= maxHops || quality.failureRatio < 0.5);

        const hopRtts = hops.map((hop) => hop.avgRtt).filter((rtt) => rtt != null);
        const averagePing = hopRtts.length
            ? Number((hopRtts.reduce((sum, rtt) => sum + rtt, 0) / hopRtts.length).toFixed(2))
            : null;

        // Report the average RTT of the observed hops, not the execution time
        // of the traceroute command itself.
        heartbeat.ping = averagePing;
        heartbeat.traceroute = JSON.stringify({
            target,
            ipv6: !!monitor.tracerouteIPv6,
            hops,
            destinationReached,
            averagePing,
            ...quality,
        });
        heartbeat.msg = this.message(output, success, hops.length, destinationReached, quality);

        if (!success) {
            throw new Error(this.message(output, false, hops.length, destinationReached, quality));
        }

        heartbeat.status = UP;
    }

    integer(value, fallback, min, max) {
        const number = Number(value);
        return Number.isFinite(number) ? Math.min(max, Math.max(min, Math.round(number))) : fallback;
    }

    parse(output) {
        const hops = [];

        for (const rawLine of output.split(/\r?\n/)) {
            const line = rawLine.trim();
            const match = line.match(/^(\d+)\s+(.+)$/);
            if (!match) {
                continue;
            }

            const tokens = match[2].split(/\s+/);
            const hopProbes = [];
            for (let i = 0; i < tokens.length; i++) {
                if (tokens[i] === "*") {
                    hopProbes.push({ ip: null, rtt: null });
                    continue;
                }

                const ipMatch = tokens[i].match(/^\\(?([0-9a-f:.]+)\\)?$/i);
                if (!ipMatch) {
                    const rtt = tokens[i].match(/^(\\d+(?:\\.\\d+)?)$/);
                    if (rtt && tokens[i + 1]?.toLowerCase() === "ms" && hopProbes.length) {
                        hopProbes[hopProbes.length - 1].rtt = Number(rtt[1]);
                        i++;
                    }
                    continue;
                }

                const ip = ipMatch[1];
                let rtt = null;
                if (i + 2 < tokens.length) {
                    const rttMatch = tokens[i + 1].match(/^(\\d+(?:\\.\\d+)?)$/);
                    if (rttMatch && tokens[i + 2].toLowerCase() === "ms") {
                        rtt = Number(rttMatch[1]);
                        i += 2;
                    }
                }
                hopProbes.push({ ip, rtt });
            }

            const valid = hopProbes.filter((probe) => probe.rtt != null).map((probe) => probe.rtt);
            hops.push({
                hop: Number(match[1]),
                ip: hopProbes.find((probe) => probe.ip)?.ip || null,
                probes: hopProbes,
                avgRtt: valid.length ? Number((valid.reduce((a, b) => a + b, 0) / valid.length).toFixed(2)) : null,
            });
        }

        return hops;
    }

    destinationReached(hops, target) {
        const last = hops[hops.length - 1];
        return !!last && last.probes.some((probe) => probe.ip === target);
    }

    pathQuality(hops) {
        if (!hops.length) {
            return {
                totalHops: 0,
                failedHops: 0,
                failureRatio: 1,
            };
        }

        const failedHops = hops.filter((hop) => {
            if (!hop.probes.length) {
                return true;
            }

            return hop.probes.every((probe) => probe.rtt == null);
        }).length;

        return {
            totalHops: hops.length,
            failedHops,
            failureRatio: Number((failedHops / hops.length).toFixed(3)),
        };
    }

    compact(output) {
        return String(output || "Traceroute failed").replace(/\s+/g, " ").trim().slice(0, 1024);
    }

    formatTraceroute(output) {
        return String(output || "")
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean)
            .join("\n")
            .slice(0, 4096);
    }

    message(output, success, hops, destinationReached, quality) {
        let status;

        if (destinationReached && success) {
            status = "Destination reached";
        } else if (success) {
            status = "Path responsive, destination not reached within max hops";
        } else if (destinationReached) {
            status = "Destination reached, but path quality is poor";
        } else {
            status = "Destination not reached";
        }

        const qualityText = quality.totalHops
            ? " (" + quality.failedHops + "/" + quality.totalHops + " hops without response)"
            : "";

        const hopRtts = hops.map((hop) => hop.avgRtt).filter((rtt) => rtt != null);
        const averagePing = hopRtts.length
            ? Number((hopRtts.reduce((sum, rtt) => sum + rtt, 0) / hopRtts.length).toFixed(2))
            : null;
        const pingText = averagePing != null ? " - Average ping: " + averagePing + " ms" : "";

        const formattedOutput = this.formatTraceroute(output);

        return formattedOutput
            ? status + " in " + hops + " hops" + qualityText + pingText + ":\n" + formattedOutput
            : status + " in " + hops + " hops" + qualityText + pingText;
    }
}

module.exports = { TracerouteMonitorType };
