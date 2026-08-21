import * as fs from "node:fs";
import type { ChildProcess } from "node:child_process";

/**
 * Process-tree teardown is only safe when the platform provides either
 * Windows' ChildProcess.kill semantics or Linux private process groups plus
 * /proc identity. POSIX hosts without those proofs must fail before spawn;
 * silently launching a non-detached child would make later group signalling
 * uninterruptible.
 */
export function processControlUnsupported(platform: NodeJS.Platform = process.platform): string | undefined {
	if (platform === "linux" || platform === "win32") return undefined;
	return `safe child process-group control is unsupported on ${platform}; refusing to spawn because descendants could become uninterruptible (requires Linux /proc identity or Windows process control)`;
}

export interface ChildProcessIdentity {
	pid: number;
	startToken?: string;
	parentPid?: number;
	pgid?: number;
	uid?: number;
}

function readChildProcessIdentity(pid: number): ChildProcessIdentity | undefined {
	if (process.platform !== "linux" || !Number.isInteger(pid) || pid <= 0) return undefined;
	try {
		const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
		const closeParen = stat.lastIndexOf(")");
		if (closeParen < 0) return undefined;
		const fields = stat.slice(closeParen + 2).trim().split(/\s+/u);
		const parentPid = Number(fields[1]);
		const pgid = Number(fields[2]);
		const startToken = fields[19];
		const uid = fs.statSync(`/proc/${pid}`).uid;
		return startToken && Number.isInteger(parentPid) && parentPid > 0 && Number.isInteger(pgid) && pgid > 0 && Number.isInteger(uid)
			? { pid, startToken, parentPid, pgid, uid }
			: undefined;
	} catch {
		return undefined;
	}
}

function childIdentityMatches(child: ChildWithPid, identity: ChildProcessIdentity | undefined): boolean {
	// Delayed detached-group signalling is supported only where /proc proves the
	// leader owns a private group. Never skip this check on an unsupported host.
	if (process.platform !== "linux") return false;
	if (!identity?.startToken || identity.pgid !== identity.pid || !Number.isInteger(identity.pid) || identity.pid <= 0 || child.pid !== identity.pid) return false;
	const current = readChildProcessIdentity(identity.pid);
	return Boolean(current && current.startToken === identity.startToken
		&& current.pgid === identity.pid
		&& (identity.uid === undefined || current.uid === identity.uid));
}

function readGroupMembers(pgid: number): ChildProcessIdentity[] {
	if (process.platform !== "linux" || !Number.isInteger(pgid) || pgid <= 0) return [];
	const members: ChildProcessIdentity[] = [];
	try {
		for (const entry of fs.readdirSync("/proc")) {
			if (!/^\d+$/u.test(entry)) continue;
			const member = readChildProcessIdentity(Number(entry));
			if (member?.pgid === pgid) members.push(member);
		}
	} catch { return []; }
	return members;
}

function groupMemberMatches(member: ChildProcessIdentity): boolean {
	if (!member.startToken || !member.pgid) return false;
	const current = readChildProcessIdentity(member.pid);
	return Boolean(current && current.startToken === member.startToken && current.pgid === member.pgid
		&& (member.uid === undefined || current.uid === member.uid));
}

/** Return false for an unreadable live PID: inability to prove identity is not proof of exit. */
function groupMemberGone(member: ChildProcessIdentity): boolean {
	if (fs.existsSync(`/proc/${member.pid}`)) {
		const current = readChildProcessIdentity(member.pid);
		if (!current) return false;
		return current.startToken !== member.startToken || current.pgid !== member.pgid
			|| (member.uid !== undefined && current.uid !== member.uid);
	}
	return true;
}

/** Capture the Linux start identity before a delayed teardown can run. */
export function captureChildProcessIdentity(child: ChildWithPid): ChildProcessIdentity | undefined {
	const pid = child.pid;
	if (!Number.isInteger(pid) || pid! <= 0) return undefined;
	// spawn() may publish pid just before /proc becomes readable; retry briefly
	// rather than converting a transient race into an unguarded teardown.
	const deadline = Date.now() + 50;
	let identity: ChildProcessIdentity | undefined;
	while (!(identity = readChildProcessIdentity(pid!)) && Date.now() < deadline) {
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);
	}
	return identity;
}

const capturedIdentities = new WeakMap<object, ChildProcessIdentity>();
const capturedGroupMembers = new WeakMap<object, ChildProcessIdentity[]>();

function rememberGroupMembers(child: ChildWithPid, pgid: number | undefined): void {
	if (process.platform !== "linux" || !pgid) return;
	const existing = capturedGroupMembers.get(child as object) ?? [];
	const known = new Set(existing.map((member) => `${member.pid}:${member.startToken}`));
	for (const member of readGroupMembers(pgid)) {
		const key = `${member.pid}:${member.startToken}`;
		if (!known.has(key)) existing.push(member);
	}
	capturedGroupMembers.set(child as object, existing);
}

/** Capture exact private-group member identities before a leader can be reaped. */
export function captureChildProcessGroupMembers(child: ChildWithPid, pgid?: number): void {
	const identity = capturedIdentities.get(child as object) ?? captureChildProcessIdentity(child);
	if (identity) capturedIdentities.set(child as object, identity);
	// A leader can exit between the identity read above and the next event. Keep
	// the last exact member snapshot even when the leader identity is unavailable;
	// those members are the only safe continuity authority after reaping.
	rememberGroupMembers(child, pgid ?? identity?.pgid ?? child.pid);
}

interface PostExitStdioGuardOptions {
	idleMs: number;
	/** Optional exact identity captured by the spawning caller. */
	identity?: ChildProcessIdentity;
	hardMs: number;
	/** The child must have been spawned detached so its process group is private. */
	killProcessGroupOnCutoff?: boolean;
	/** Notifies terminal gates that the bounded KILL escalation was delivered. */
	onHardCutoff?: () => void;
	/** Refused/unknown identity is terminal evidence, not permission to poll forever. */
	onTeardownFailure?: (reason: string) => void;
	/** Called once bounded teardown is proven complete (including KILL delivery). */
	onTeardownComplete?: () => void;
}

export interface StdioGuardCleanupOptions {
	/** The caller has independently proven that the detached process group is gone. */
	groupTeardownProven?: boolean;
}

interface ChildWithPipedStdio {
	pid?: number;
	kill: ChildProcess["kill"];
	stdout: ChildProcess["stdout"];
	stderr: ChildProcess["stderr"];
	on: ChildProcess["on"];
}

interface ChildWithKill {
	kill(signal?: NodeJS.Signals | number): boolean;
}

interface ChildWithPid extends ChildWithKill {
	pid?: number;
	exitCode?: number | null;
	signalCode?: NodeJS.Signals | null;
}

export function trySignalChild(child: ChildWithKill, signal: NodeJS.Signals): boolean {
	try {
		return child.kill(signal);
	} catch {
		return false;
	}
}

/**
 * Signal a detached child and every process it spawned.
 *
 * A direct kill is insufficient for Bubblewrap, shells, and tools that spawn
 * their own workers: those descendants otherwise survive after the wrapper
 * exits or the runner is interrupted. Detached children have a private process
 * group, so a negative PID targets only that group on POSIX.
 */
export function isChildProcessGroupGone(child: ChildWithPid, options: { detachedGroup?: boolean } = {}): boolean {
	if ((options.detachedGroup ?? true) === false) return child.pid === undefined;
	return isExactChildProcessGroupGone(child);
}

/** Poll exact private-group disappearance; a zombie leader or reused PGID is insufficient proof. */
export async function waitForChildProcessGroupGone(child: ChildWithPid, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + Math.max(0, timeoutMs);
	while (!isExactChildProcessGroupGone(child) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
	return isExactChildProcessGroupGone(child);
}

function isExactChildProcessGroupGone(child: ChildWithPid): boolean {
	if (process.platform === "win32") return child.exitCode != null || child.signalCode != null || child.pid === undefined;
	if (process.platform !== "linux") return false;
	const pid = child.pid;
	if (!Number.isInteger(pid) || pid === undefined || pid <= 0) return false;
	// A successful group probe means that *some* process group with this PGID
	// exists. Even when every captured member disappeared, that can be PGID
	// reuse, so it is never teardown proof.
	try {
		process.kill(-pid, 0);
		return false;
	} catch (error) {
		if ((error as NodeJS.ErrnoException)?.code !== "ESRCH") return false;
	}
	// ESRCH is useful only when we captured exact original members first. An
	// unknown PID/group must fail closed rather than being treated as gone.
	const members = capturedGroupMembers.get(child as object) ?? [];
	return members.length > 0 && members.every(groupMemberGone);
}

export function signalChildProcessGroup(child: ChildWithPid, signal: NodeJS.Signals, options: { detachedGroup?: boolean; identity?: ChildProcessIdentity } = {}): boolean {
	const detachedGroup = options.detachedGroup ?? true;
	if (process.platform !== "win32" && detachedGroup) {
		const pid = child.pid;
		if (!Number.isFinite(pid) || !Number.isInteger(pid) || pid <= 0) return false;
		// Every delayed group signal must prove that the original leader still
		// owns this PID. Never fall back to a reused direct PID or PGID.
		const identity = options.identity ?? capturedIdentities.get(child as object);
		if (childIdentityMatches(child, identity)) {
			rememberGroupMembers(child, pid);
		} else {
			// Once the leader is reaped, continuity must come from an exact member
			// identity captured while the original private group was still observable.
			// A terminal ChildProcess handle alone is not authority for a reused PGID.
			const members = capturedGroupMembers.get(child as object) ?? [];
			if (!members.some((member) => member.pgid === pid && groupMemberMatches(member))) return false;
		}
		try {
			process.kill(-pid, signal);
			return true;
		} catch {
			return false;
		}
	}
	return trySignalChild(child, signal);
}

export function attachPostExitStdioGuard(
	child: ChildWithPipedStdio,
	options: PostExitStdioGuardOptions,
): (cleanupOptions?: StdioGuardCleanupOptions) => void {
	const { idleMs, hardMs, killProcessGroupOnCutoff = false, onHardCutoff, onTeardownComplete, onTeardownFailure } = options;
	let exited = false;
	let stdoutEnded = false;
	let stderrEnded = false;
	let cutoffStarted = false;
	let mandatoryEscalationOwed = false;
	let cleanedUp = false;
	let teardownCompleted = false;
	let killVerificationInFlight = false;
	let idleTimer: NodeJS.Timeout | undefined;
	let hardTimer: NodeJS.Timeout | undefined;
	const childIdentity = options.identity ?? captureChildProcessIdentity(child);
	if (childIdentity) {
		capturedIdentities.set(child as object, childIdentity);
		rememberGroupMembers(child, childIdentity.pgid);
	}

	const destroyUnendedStdio = () => {
		if (!stdoutEnded) {
			try { child.stdout?.destroy(); } catch {}
		}
		if (!stderrEnded) {
			try { child.stderr?.destroy(); } catch {}
		}
	};

	const terminateLeakedProcessGroup = (signal: NodeJS.Signals): boolean => {
		if (!killProcessGroupOnCutoff) return false;
		return signalChildProcessGroup(child, signal, { identity: childIdentity });
	};
	const completeTeardown = (): void => {
		if (teardownCompleted) return;
		teardownCompleted = true;
		onTeardownComplete?.();
	};

	const cutoff = (signal: NodeJS.Signals): void => {
		cutoffStarted = true;
		if (signal === "SIGTERM") {
			mandatoryEscalationOwed = true;
			if (killProcessGroupOnCutoff && !hardTimer) {
				hardTimer = setTimeout(() => cutoff("SIGKILL"), hardMs);
				hardTimer.unref?.();
			}
		}
		if (idleTimer) {
			clearTimeout(idleTimer);
			idleTimer = undefined;
		}
		if (signal === "SIGKILL") {
			if (killVerificationInFlight || teardownCompleted) return;
			killVerificationInFlight = true;
			const delivered = terminateLeakedProcessGroup(signal);
			// Accepted SIGKILL delivery is not teardown proof. Poll the exact private
			// group until it disappears; an unknown or reused group stays actionable.
			void (async () => {
				const proven = delivered && await waitForChildProcessGroupGone(child, hardMs);
				killVerificationInFlight = false;
				mandatoryEscalationOwed = false;
				hardTimer = undefined;
				if (proven || (!delivered && isExactChildProcessGroupGone(child))) {
					onHardCutoff?.();
					completeTeardown();
				} else {
					onTeardownFailure?.("private process-group KILL was delivered but teardown could not be proven before the hard cutoff");
				}
			})();
		} else {
			terminateLeakedProcessGroup(signal);
		}
		destroyUnendedStdio();
	};

	const clearTimers = (cleanupOptions: StdioGuardCleanupOptions = {}) => {
		cleanedUp = true;
		if (idleTimer) {
			clearTimeout(idleTimer);
			idleTimer = undefined;
		}
		// Close/error handlers run after the cutoff has destroyed the pipes. They
		// are not proof that descendants left the private group, so retain the
		// mandatory KILL timer unless the caller explicitly proved teardown.
		if (hardTimer && (!mandatoryEscalationOwed || cleanupOptions.groupTeardownProven)) {
			clearTimeout(hardTimer);
			hardTimer = undefined;
			if (cleanupOptions.groupTeardownProven) mandatoryEscalationOwed = false;
		}
	};

	const clearTimersAfterNaturalStdioCompletion = () => {
		if (!cutoffStarted && stdoutEnded && stderrEnded) {
			if (killProcessGroupOnCutoff && !isChildProcessGroupGone(child)) cutoff("SIGTERM");
			else clearTimers({ groupTeardownProven: true });
		}
	};

	const armIdleTimer = () => {
		if (!exited || cleanedUp || cutoffStarted) return;
		if (idleTimer) clearTimeout(idleTimer);
		idleTimer = setTimeout(() => cutoff("SIGTERM"), idleMs);
		idleTimer.unref?.();
	};

	child.stdout?.on("data", armIdleTimer);
	child.stderr?.on("data", armIdleTimer);
	child.stdout?.on("end", () => {
		stdoutEnded = true;
		clearTimersAfterNaturalStdioCompletion();
	});
	child.stderr?.on("end", () => {
		stderrEnded = true;
		clearTimersAfterNaturalStdioCompletion();
	});
	child.on("exit", () => {
		exited = true;
		// Capture surviving descendants before the leader is reaped; this exact
		// member continuity is what authorizes later TERM/KILL escalation.
		rememberGroupMembers(child, childIdentity?.pgid);
		armIdleTimer();
		if (cleanedUp || cutoffStarted || hardTimer) return;
		hardTimer = setTimeout(() => cutoff("SIGKILL"), hardMs);
	});
	child.on("close", () => {
		// The wrapper's close event only proves that its pipes closed. A detached
		// descendant (including one with stdio=ignore) may still own this private
		// group, so make teardown escalation a terminal gate rather than clearing
		// the hard cutoff here.
		if (killProcessGroupOnCutoff && !isChildProcessGroupGone(child)) {
			cutoff("SIGTERM");
			return;
		}
		if (!cutoffStarted) {
			clearTimers({ groupTeardownProven: true });
			completeTeardown();
			return;
		}
		// TERM may have completed the private-group teardown before the wrapper's
		// close event. That is independent proof, so release the terminal gate now
		// instead of waiting for the (otherwise mandatory) KILL deadline.
		if (killProcessGroupOnCutoff && isChildProcessGroupGone(child)) {
			clearTimers({ groupTeardownProven: true });
			completeTeardown();
		}
	});
	child.on("error", () => {
		if (!cutoffStarted) clearTimers();
	});

	return clearTimers;
}
