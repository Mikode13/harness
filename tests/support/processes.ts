import { readFileSync } from 'node:fs';

/**
 * Whether the process `pid` still runs. A zombie, killed but not yet reaped, does not: where
 * PID 1 does not reap, as in some containers, a killed orphan stays one, and `kill(pid, 0)`
 * still finds it. Only Linux says so through `/proc`; elsewhere the signal alone answers.
 */
export function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
	} catch {
		return false;
	}
	if (process.platform !== 'linux') return true;
	try {
		// The state follows the command's name, which is in parentheses and may hold spaces.
		const stat = readFileSync(`/proc/${String(pid)}/stat`, 'utf8');
		return stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3) !== 'Z';
	} catch {
		// Gone between the signal and the read.
		return false;
	}
}
