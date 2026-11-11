import * as filesystem from "node:fs";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import {
	runWindowTool,
	windowImageIdentity,
	windowVolumeBytes,
} from "./codex-window-containment.mjs";
import {
	ownedWindowDirectory,
	windowRequire,
} from "./codex-window-conformance.mjs";

export const windowCaseQuotaBytes = 67108864;
export const windowOverheadBytes = 134217728;
const names = ["HarnessQuotaBase", "HarnessQuotaState", "HarnessQuotaEvidence"];
const device = z.string().regex(/^\/dev\/disk[0-9]+(?:s[0-9]+)*$/);
const diskId = z.string().regex(/^disk[0-9]+(?:s[0-9]+)*$/);
const entity = z.object({
	"dev-entry": device,
	"content-hint": z.string().optional(),
	"mount-point": z.string().optional(),
});
const entitiesSchema = z.object({
	"system-entities": z.array(entity).min(1).max(16),
});
const infoSchema = z.object({
	images: z.array(entitiesSchema.extend({ "image-path": z.string() })).max(
		64,
	),
});
const volumeSchema = z.object({
	Name: z.string(),
	DeviceIdentifier: diskId,
	APFSVolumeUUID: z.string().min(1).max(128),
	CapacityQuota: z.number().int().nonnegative(),
});
const listSchema = z.object({
	Containers: z.array(z.object({
		ContainerReference: diskId,
		APFSContainerUUID: z.string().min(1).max(128),
		CapacityCeiling: z.number().int().positive().max(windowVolumeBytes),
		PhysicalStores: z.array(z.object({ DeviceIdentifier: diskId })).length(
			1,
		),
		Volumes: z.array(volumeSchema).min(1).max(3),
	})).length(1),
});
const same = (a, b) => Object.keys(a).every((key) => a[key] === b[key]);

class OwnedQuota {
	constructor(root, options) {
		ownedWindowDirectory(root);
		this.root = root;
		this.fs = options.fs ?? filesystem;
		this.run = options.run ?? runWindowTool;
		this.onCreated = options.onCreated;
		this.onPhase = options.onPhase;
		this.onCleanup = options.onCleanup;
		this.imagePath = join(root, "volume.sparseimage");
		this.mountRoot = join(root, "mounts");
		this.caseRoot = join(this.mountRoot, names[1], "private");
		this.evidenceRoot = join(this.mountRoot, names[2], "private");
		this.guardRoots = new Map();
		windowRequire(
			!this.fs.existsSync(this.imagePath) &&
				!this.fs.existsSync(this.mountRoot),
			"quota_not_fresh",
		);
		this.fs.mkdirSync(this.mountRoot, { mode: 0o700 });
		this.mountIdentity = this.fs.lstatSync(this.mountRoot);
		this.deadline = Date.now() + 120000;
	}
	async phase(name) {
		await this.onPhase?.(name, this.identity ?? null);
	}
	tool(command, args, settings = {}) {
		const remaining = this.deadline - Date.now();
		windowRequire(remaining > 0, "quota_tool_deadline");
		return this.run(command, args, {
			...settings,
			root: this.root,
			timeoutMs: Math.min(45000, remaining),
		});
	}
	async parse(result, schema) {
		const converted = await this.tool("/usr/bin/plutil", [
			"-convert",
			"json",
			"-o",
			"-",
			"-",
		], { input: result.stdout });
		windowRequire(converted.code === 0, "quota_inspection_failed");
		const parsed = schema.safeParse(JSON.parse(converted.stdout));
		windowRequire(parsed.success, "quota_inspection_failed");
		return parsed.data;
	}
	async plist(command, args, schema) {
		const result = await this.tool(command, args);
		windowRequire(result.code === 0, "quota_inspection_failed");
		return this.parse(result, schema);
	}
	directory(path) {
		const stat = this.fs.lstatSync(path);
		windowRequire(
			resolve(path) === path && this.fs.realpathSync(path) === path &&
				stat.isDirectory() &&
				!stat.isSymbolicLink() && stat.uid === process.getuid() &&
				(stat.mode & 0o777) === 0o700,
			"quota_ownership_unverified",
		);
		return stat;
	}
	checkIdentity() {
		windowRequire(
			this.identity &&
				same(this.identity, windowImageIdentity(this.root)),
			"quota_ownership_unverified",
		);
		const mount = this.directory(this.mountRoot);
		windowRequire(
			mount.dev === this.mountIdentity.dev &&
				mount.ino === this.mountIdentity.ino,
			"quota_ownership_unverified",
		);
	}
	async attachment(required = true) {
		this.checkIdentity();
		const info = await this.plist(
			"/usr/bin/hdiutil",
			["info", "-plist"],
			infoSchema,
		);
		this.checkIdentity();
		const matches = info.images.filter((row) =>
			row["image-path"] === this.imagePath
		);
		windowRequire(
			matches.length <= 1 && (!required || matches.length === 1),
			"quota_ownership_unverified",
		);
		const rows = matches[0]?.["system-entities"];
		if (!rows) return null;
		const devices = rows.map((row) => row["dev-entry"]);
		windowRequire(
			new Set(devices).size === devices.length &&
				(!this.physical || devices.includes(this.physical)) &&
				(!this.whole || devices.includes(this.whole)),
			"quota_ownership_unverified",
		);
		for (const image of info.images) {
			for (const row of image["system-entities"]) {
				const point = row["mount-point"];
				windowRequire(
					image["image-path"] === this.imagePath
						? !point ||
							names.some((name) =>
								point === join(this.mountRoot, name)
							)
						: !devices.includes(row["dev-entry"]) &&
							(!point ||
								(point !== this.mountRoot &&
									!point.startsWith(this.mountRoot + "/"))),
					"quota_ownership_unverified",
				);
			}
		}
		const disks = rows.filter((row) =>
			row["content-hint"] === "GUID_partition_scheme"
		);
		windowRequire(
			disks.length === 1 &&
				/^\/dev\/disk[0-9]+$/.test(disks[0]["dev-entry"]) &&
				(!this.whole || this.whole === disks[0]["dev-entry"]),
			"quota_ownership_unverified",
		);
		this.whole = disks[0]["dev-entry"];
		return rows;
	}
	async detach() {
		const rows = await this.attachment(false);
		if (rows) {
			const result = await this.tool("/usr/bin/hdiutil", [
				"detach",
				this.whole,
			]);
			windowRequire(result.code === 0, "quota_cleanup_unverified");
		}
		windowRequire(
			await this.attachment(false) === null,
			"quota_cleanup_unverified",
		);
	}
	async inspect(count, mounted) {
		const rows = await this.attachment();
		windowRequire(
			this.physical &&
				rows.some((row) => row["dev-entry"] === this.physical),
			"quota_ownership_unverified",
		);
		const disk = await this.plist(
			"/usr/sbin/diskutil",
			["info", "-plist", this.physical],
			z.object({
				APFSContainerReference: z.string().regex(/^disk[0-9]+$/),
			}),
		);
		const listed = await this.plist("/usr/sbin/diskutil", [
			"apfs",
			"list",
			"-plist",
			disk.APFSContainerReference,
		], listSchema);
		const container = listed.Containers[0];
		windowRequire(
			container.ContainerReference === disk.APFSContainerReference &&
				"/dev/" + container.PhysicalStores[0].DeviceIdentifier ===
					this.physical &&
				(!this.containerUuid ||
					container.APFSContainerUUID === this.containerUuid) &&
				container.Volumes.length === count,
			"quota_membership_unverified",
		);
		this.containerUuid ??= container.APFSContainerUUID;
		for (const [i, name] of names.slice(0, count).entries()) {
			const volumes = container.Volumes.filter((volume) =>
				volume.Name === name
			);
			windowRequire(volumes.length === 1, "quota_membership_unverified");
			const volume = volumes[0];
			windowRequire(
				volume.CapacityQuota === (i ? windowCaseQuotaBytes : 0) &&
					(!this.volumeUuids?.[name] ||
						this.volumeUuids[name] === volume.APFSVolumeUUID),
				"quota_value_unverified",
			);
			const members = rows.filter((row) =>
				row["dev-entry"] === "/dev/" + volume.DeviceIdentifier
			);
			windowRequire(
				members.length === 1 &&
					(mounted
						? members[0]["mount-point"] ===
							join(this.mountRoot, name)
						: !members[0]["mount-point"]),
				"quota_ownership_unverified",
			);
			if (mounted) {
				const point = join(this.mountRoot, name),
					stat = this.fs.lstatSync(point);
				windowRequire(
					this.fs.realpathSync(point) === point &&
						stat.isDirectory() && !stat.isSymbolicLink() &&
						stat.dev !== this.mountIdentity.dev,
					"quota_ownership_unverified",
				);
			}
		}
		windowRequire(
			rows.filter((row) => row["mount-point"]).length ===
				(mounted ? count : 0),
			"quota_ownership_unverified",
		);
		this.volumeUuids = Object.fromEntries(
			container.Volumes.map(
				(volume) => [volume.Name, volume.APFSVolumeUUID],
			),
		);
		return { rows, container };
	}
	close() {
		this.closing ??= (async () => {
			this.deadline = Date.now() + 30000;
			await this.phase("cleanup-begin");
			await this.detach();
			this.checkIdentity();
			this.fs.unlinkSync(this.imagePath);
			windowRequire(
				!this.fs.existsSync(this.imagePath),
				"quota_cleanup_unverified",
			);
			const result = {
				detached: true,
				ownedImageDeleted: true,
				identity: this.identity,
			};
			await this.phase("cleanup-complete");
			await this.onCleanup?.(result);
			return result;
		})();
		return this.closing;
	}
	async attach(mounted) {
		this.checkIdentity();
		await this.phase(mounted ? "mount-begin" : "attach-begin");
		const result = await this.tool("/usr/bin/hdiutil", [
			"attach",
			this.imagePath,
			...(mounted
				? ["-mountroot", this.mountRoot, "-noautoopen"]
				: ["-nomount"]),
			"-nobrowse",
			"-owners",
			mounted ? "off" : "on",
			"-plist",
		]);
		// Attach and info use different APFS hints; bind the returned store by exact device membership.
		if (result.stdout) {
			const attached = await this.parse(result, entitiesSchema);
			const stores = attached["system-entities"].filter((row) =>
				row["content-hint"] === "Apple_APFS"
			);
			windowRequire(
				stores.length === 1 &&
					/^\/dev\/disk[0-9]+s[0-9]+$/.test(stores[0]["dev-entry"]),
				"quota_ownership_unverified",
			);
			this.physical = stores[0]["dev-entry"];
			this.whole = undefined;
		}
		windowRequire(
			result.code === 0 && this.physical,
			"quota_attach_failed",
		);
		await this.phase(mounted ? "mount-complete" : "attach-complete");
	}
	async create() {
		await this.phase("create-begin");
		let created;
		try {
			created = await this.tool("/usr/bin/hdiutil", [
				"create",
				"-size",
				"4g",
				"-fs",
				"APFS",
				"-type",
				"SPARSE",
				"-volname",
				names[0],
				"-nospotlight",
				this.imagePath,
			]);
		} finally {
			if (this.fs.existsSync(this.imagePath)) {
				const stat = this.fs.lstatSync(this.imagePath);
				windowRequire(
					stat.isFile() && !stat.isSymbolicLink() &&
						stat.uid === process.getuid() && stat.nlink === 1,
					"quota_ownership_unverified",
				);
				this.fs.chmodSync(this.imagePath, 0o600);
				this.identity = windowImageIdentity(this.root);
			}
			await this.phase("create-complete");
		}
		windowRequire(
			created.code === 0 && this.identity,
			"quota_create_failed",
		);
		await this.onCreated?.(this.identity);
		await this.attach(false);
		const initial = await this.inspect(1, false);
		for (const [index, name] of names.slice(1).entries()) {
			await this.phase(
				index ? "evidence-volume-begin" : "state-volume-begin",
			);
			const added = await this.tool("/usr/sbin/diskutil", [
				"apfs",
				"addVolume",
				initial.container.ContainerReference,
				"APFS",
				name,
				"-nomount",
				"-quota",
				String(windowCaseQuotaBytes),
			]);
			windowRequire(added.code === 0, "quota_create_failed");
			await this.phase(
				index ? "evidence-volume-complete" : "state-volume-complete",
			);
			await this.inspect(index + 2, false);
		}
		await this.phase("remount-begin");
		await this.detach();
		await this.attach(true);
		await this.inspect(3, true);
		this.fs.mkdirSync(this.caseRoot, { mode: 0o700 });
		this.fs.mkdirSync(this.evidenceRoot, { mode: 0o700 });
		this.caseIdentity = this.directory(this.caseRoot);
		this.evidenceIdentity = this.directory(this.evidenceRoot);
		windowRequire(
			this.caseIdentity.dev ===
				this.fs.lstatSync(join(this.mountRoot, names[1])).dev,
			"quota_ownership_unverified",
		);
		windowRequire(
			this.evidenceIdentity.dev ===
				this.fs.lstatSync(join(this.mountRoot, names[2])).dev,
			"quota_ownership_unverified",
		);
		await this.phase("startup-complete");
	}
	async verifyWritablePaths(paths) {
		windowRequire(
			!this.closing && Array.isArray(paths) && paths.length > 0 &&
				paths.length <= 64,
			"quota_paths_invalid",
		);
		const state = await this.inspect(3, true);
		const current = this.directory(this.caseRoot);
		windowRequire(
			current.dev === this.caseIdentity.dev &&
				current.ino === this.caseIdentity.ino &&
				current.dev ===
					this.fs.lstatSync(join(this.mountRoot, names[1])).dev,
			"quota_ownership_unverified",
		);
		for (const path of paths) {
			windowRequire(
				typeof path === "string" &&
					(path === this.caseRoot ||
						path.startsWith(this.caseRoot + "/")),
				"quota_paths_invalid",
			);
			for (let parent = path;; parent = dirname(parent)) {
				windowRequire(
					this.directory(parent).dev === current.dev,
					"quota_paths_invalid",
				);
				if (parent === this.caseRoot) break;
			}
		}
		this.checkIdentity();
		return {
			quotaBytes: windowCaseQuotaBytes,
			capacityBytes: state.container.CapacityCeiling,
			identity: this.identity,
			caseIdentity: {
				dev: current.dev,
				ino: current.ino,
				uid: current.uid,
				mode: current.mode & 0o777,
			},
			container: state.container,
			entities: state.rows,
			writablePaths: [...paths],
		};
	}
	async measureOverhead(roots = []) {
		windowRequire(!this.overheadExceeded, "quota_overhead_exceeded");
		this.checkIdentity();
		windowRequire(
			Array.isArray(roots) && roots.length <= 64,
			"quota_overhead_unverified",
		);
		for (const root of roots) {
			ownedWindowDirectory(root);
			if (!this.guardRoots.has(root)) {
				this.guardRoots.set(root, this.fs.lstatSync(root));
			}
		}
		windowRequire(this.guardRoots.size <= 64, "quota_overhead_unverified");
		// Charge the entire allocated image, including payload, so shared/compressed
		// APFS extents can never make subtraction understate metadata overhead.
		let guardBytes = 0;
		const visited = new Set();
		const visit = (path) => {
			if (visited.has(path)) return;
			visited.add(path);
			windowRequire(visited.size <= 65536, "quota_overhead_unverified");
			const stat = this.fs.lstatSync(path);
			windowRequire(
				!stat.isSymbolicLink() && stat.uid === process.getuid(),
				"quota_overhead_unverified",
			);
			windowRequire(
				Number.isSafeInteger(stat.blocks) && stat.blocks >= 0,
				"quota_overhead_unverified",
			);
			guardBytes += stat.blocks * 512;
			if (guardBytes > windowOverheadBytes) this.overheadExceeded = true;
			windowRequire(!this.overheadExceeded, "quota_overhead_exceeded");
			if (stat.isDirectory()) {
				for (const name of this.fs.readdirSync(path)) {
					const child = join(path, name);
					if (child !== this.mountRoot && child !== this.imagePath) {
						visit(child);
					}
				}
			}
		};
		visit(this.root);
		for (const [root, identity] of this.guardRoots) {
			const current = this.directory(root);
			windowRequire(
				current.dev === identity.dev && current.ino === identity.ino,
				"quota_overhead_unverified",
			);
			visit(root);
		}
		const imageAllocatedBytes = this.fs.lstatSync(this.imagePath).blocks *
			512;
		const mountMetadataBytes = this.fs.lstatSync(this.mountRoot).blocks *
			512;
		const chargedBytes = guardBytes + imageAllocatedBytes +
			mountMetadataBytes;
		windowRequire(
			Number.isSafeInteger(chargedBytes),
			"quota_overhead_unverified",
		);
		this.overheadExceeded = chargedBytes > windowOverheadBytes;
		windowRequire(!this.overheadExceeded, "quota_overhead_exceeded");
		return {
			limitBytes: windowOverheadBytes,
			chargedBytes,
			guardBytes,
			imageAllocatedBytes,
			mountMetadataBytes,
			accounting: "allocated_guard_and_whole_image_upper_bound",
		};
	}
	async writeEvidence(name, bytes) {
		windowRequire(!this.overheadExceeded, "quota_overhead_exceeded");
		windowRequire(
			typeof name === "string" &&
				/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(name),
			"evidence_path_invalid",
		);
		windowRequire(
			Buffer.isBuffer(bytes) && bytes.length <= windowCaseQuotaBytes,
			"evidence_bytes_invalid",
		);
		await this.inspect(3, true);
		const current = this.directory(this.evidenceRoot);
		windowRequire(
			current.dev === this.evidenceIdentity.dev &&
				current.ino === this.evidenceIdentity.ino &&
				current.dev ===
					this.fs.lstatSync(join(this.mountRoot, names[2])).dev,
			"quota_ownership_unverified",
		);
		await this.measureOverhead();
		const fd = this.fs.openSync(
			join(this.evidenceRoot, name),
			filesystem.constants.O_WRONLY | filesystem.constants.O_CREAT |
				filesystem.constants.O_EXCL | filesystem.constants.O_NOFOLLOW,
			0o600,
		);
		try {
			this.fs.writeFileSync(fd, bytes);
		} finally {
			this.fs.closeSync(fd);
		}
		const overhead = await this.measureOverhead();
		return {
			quotaBytes: windowCaseQuotaBytes,
			bytes: bytes.length,
			overhead,
		};
	}
}

export async function createOwnedWindowQuota(root, options = {}) {
	const quota = new OwnedQuota(root, options);
	try {
		await quota.create();
		return Object.freeze({
			imagePath: quota.imagePath,
			caseRoot: quota.caseRoot,
			evidenceRoot: quota.evidenceRoot,
			verifyWritablePaths: (paths) => quota.verifyWritablePaths(paths),
			writeEvidence: (name, bytes) => quota.writeEvidence(name, bytes),
			measureOverhead: (roots) => quota.measureOverhead(roots),
			close: () => quota.close(),
		});
	} catch (error) {
		if (quota.identity) await quota.close();
		throw error;
	}
}
