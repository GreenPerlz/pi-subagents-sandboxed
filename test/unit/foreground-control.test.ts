import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { registerForegroundInterrupt } from "../../src/runs/shared/foreground-control.ts";

describe("foreground interrupt registrations", () => {
	it("clears after A then B unregister", () => {
		const control: { interrupt?: () => boolean } = {};
		const removeA = registerForegroundInterrupt(control, () => true);
		const removeB = registerForegroundInterrupt(control, () => true);

		removeA();
		assert.notEqual(control.interrupt, undefined);
		removeB();
		assert.equal(control.interrupt, undefined);
	});

	it("clears after B then A unregister", () => {
		const control: { interrupt?: () => boolean } = {};
		const removeA = registerForegroundInterrupt(control, () => true);
		const removeB = registerForegroundInterrupt(control, () => true);
		const dispatch = control.interrupt;

		removeB();
		assert.equal(control.interrupt, dispatch);
		removeA();
		assert.equal(control.interrupt, undefined);
	});

	it("makes unregister idempotent", () => {
		const control: { interrupt?: () => boolean } = {};
		const remove = registerForegroundInterrupt(control, () => true);

		remove();
		remove();
		assert.equal(control.interrupt, undefined);
	});

	it("does not invoke a retired dispatcher after registering again", () => {
		const control: { interrupt?: () => boolean } = {};
		const calls: string[] = [];
		const removeA = registerForegroundInterrupt(control, () => { calls.push("a"); return true; });
		const staleDispatch = control.interrupt!;
		removeA();

		const removeB = registerForegroundInterrupt(control, () => { calls.push("b"); return true; });
		assert.notEqual(control.interrupt, staleDispatch);
		assert.equal(staleDispatch(), false);
		assert.deepEqual(calls, []);
		assert.equal(control.interrupt?.(), true);
		assert.deepEqual(calls, ["b"]);
		removeB();
	});

	it("marks the global interrupt before dispatching active children", () => {
		const control: { interrupt?: () => boolean; interruptRequested?: boolean } = {};
		const remove = registerForegroundInterrupt(control, () => true);
		assert.equal(control.interruptRequested, undefined);
		assert.equal(control.interrupt?.(), true);
		assert.equal(control.interruptRequested, true);
		remove();
	});

	it("invokes each callback once from a dispatch snapshot when one unregisters", () => {
		const control: { interrupt?: () => boolean } = {};
		const calls: string[] = [];
		let removeB = () => {};
		const removeA = registerForegroundInterrupt(control, () => {
			calls.push("a");
			removeB();
			return false;
		});
		removeB = registerForegroundInterrupt(control, () => { calls.push("b"); return true; });

		assert.equal(control.interrupt?.(), true);
		assert.deepEqual(calls, ["a", "b"]);
		calls.length = 0;
		assert.equal(control.interrupt?.(), false);
		assert.deepEqual(calls, ["a"]);
		removeA();
		assert.equal(control.interrupt, undefined);
	});

	it("does not clear a newer external interrupt during stale unregister", () => {
		const control: { interrupt?: () => boolean } = {};
		const removeA = registerForegroundInterrupt(control, () => true);
		const removeB = registerForegroundInterrupt(control, () => true);
		removeB();
		const external = () => true;
		control.interrupt = external;

		removeA();
		assert.equal(control.interrupt, external);
		assert.equal(control.interrupt?.(), true);
	});
});
