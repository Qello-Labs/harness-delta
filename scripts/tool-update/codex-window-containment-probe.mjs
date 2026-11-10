import { spawnSync } from "node:child_process";
import { createSocket } from "node:dgram";
import { Resolver } from "node:dns";
import {
	closeSync,
	openSync,
	readFileSync,
	statSync,
	writeSync,
} from "node:fs";
import { createConnection } from "node:net";

const [mode, configPath, role] = process.argv.slice(2);
const configBytes = readFileSync(configPath);
if (configBytes.length > 8192) process.exit(2);
const config = JSON.parse(configBytes.toString("utf8"));
const denied = (code) => code === "EPERM" || code === "EACCES";
const result = (ok, code, writtenBytes = 0) => ({
	name: mode,
	descendant: role === "descendant",
	ok,
	code,
	written_bytes: writtenBytes,
});

async function socketProbe(loopback) {
	return new Promise((resolveResult) => {
		const socket = createConnection({
			host: loopback ? "127.0.0.1" : "198.51.100.1",
			port: loopback ? config.port : 443,
		});
		let received = "", finished = false;
		const done = (value) => {
			if (finished) return;
			finished = true;
			clearTimeout(timer);
			socket.destroy();
			resolveResult(value);
		};
		const timer = setTimeout(() => done(result(false, "ETIMEDOUT")), 3000);
		socket.once(
			"error",
			(error) =>
				done(result(!loopback && denied(error.code), error.code)),
		);
		socket.on("data", (bytes) => {
			received += bytes.toString("utf8");
			if (received.length > 262144) done(result(false, "wire_limit"));
		});
		socket.once("connect", () => {
			if (!loopback) {
				done(result(false, "allowed"));
				return;
			}
			const body = JSON.stringify({
				model: "gpt-6.1-sol",
				reasoning: { effort: "high" },
				stream: true,
				input: [],
			});
			socket.write(
				`POST /v1/responses HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: ${
					Buffer.byteLength(body)
				}\r\n\r\n${body}`,
			);
		});
		socket.once(
			"end",
			() =>
				done(
					result(
						loopback && received.includes("HTTP/1.1 200 OK") &&
							received.includes("response.completed"),
						"allowed",
					),
				),
		);
	});
}

async function dnsProbe() {
	const transport = await new Promise((resolveResult) => {
		const socket = createSocket("udp4");
		let finished = false;
		const done = (code) => {
			if (finished) return;
			finished = true;
			clearTimeout(timer);
			socket.close();
			resolveResult(code);
		};
		const timer = setTimeout(() => done("ETIMEDOUT"), 3000);
		socket.once("error", (error) => done(error.code));
		socket.send(
			Buffer.from([
				0,
				1,
				1,
				0,
				0,
				1,
				0,
				0,
				0,
				0,
				0,
				0,
				7,
				101,
				120,
				97,
				109,
				112,
				108,
				101,
				3,
				99,
				111,
				109,
				0,
				0,
				1,
				0,
				1,
			]),
			53,
			"198.51.100.1",
			(error) => done(error?.code ?? "allowed"),
		);
	});
	const resolver = new Resolver({ timeout: 500, tries: 1 });
	resolver.setServers(["198.51.100.1"]);
	const resolution = await new Promise((resolveResult) =>
		resolver.resolve4(
			"example.com",
			(error) => resolveResult(error?.code ?? "allowed"),
		)
	);
	return result(denied(transport) && resolution !== "allowed", transport);
}

function fileProbe() {
	let fd;
	try {
		if (mode === "home_stat") statSync(config.homePath);
		else if (mode === "outside_read") readFileSync(config.outsideRead);
		else fd = openSync(config.outsideWrite, "wx", 0o600);
		return result(false, "allowed");
	} catch (error) {
		return result(denied(error.code), error.code);
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

function quotaProbe() {
	let fd, written = 0;
	const buffer = Buffer.alloc(1048576, 0x5a);
	try {
		fd = openSync(
			role === "descendant" ? config.descendantQuota : config.quota,
			"wx",
			0o600,
		);
		while (written <= 4294967296) {
			written += writeSync(fd, buffer, 0, buffer.length, written);
		}
		return result(false, "quota_not_enforced", written);
	} catch (error) {
		return result(
			error.code === "ENOSPC" || error.code === "EDQUOT",
			error.code,
			written,
		);
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

let observed;
if (role === "fork") {
	const child = spawnSync(process.execPath, [
		process.argv[1],
		mode,
		configPath,
		"descendant",
	], {
		env: {
			PATH: "/usr/bin:/bin",
			HOME: config.caseRoot,
			TMPDIR: config.caseRoot,
			OPENSSL_CONF: config.openssl_conf,
			LC_ALL: "C",
			TZ: "UTC",
		},
		timeout: mode === "quota" ? 120000 : 10000,
		encoding: "utf8",
		maxBuffer: 8192,
	});
	if (child.status !== 0) process.exit(3);
	observed = JSON.parse(child.stdout);
} else {
	switch (mode) {
		case "loopback":
			observed = await socketProbe(true);
			break;
		case "external_tcp":
			observed = await socketProbe(false);
			break;
		case "dns":
			observed = await dnsProbe();
			break;
		case "outside_read":
		case "home_stat":
		case "outside_write":
			observed = fileProbe();
			break;
		case "quota":
			observed = quotaProbe();
			break;
		case "exec_denied": {
			const child = spawnSync("/usr/bin/true", [], {
				timeout: 3000,
				stdio: "ignore",
			});
			observed = result(
				denied(child.error?.code),
				child.error?.code ?? "allowed",
			);
			break;
		}
		default:
			process.exit(2);
	}
}
process.stdout.write(JSON.stringify(observed) + "\n");
