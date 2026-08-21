export interface ForegroundInterruptControl {
	interrupt?: () => boolean;
	interruptHandlers?: Set<() => boolean>;
	/** Set before dispatching so queued work can decline to start. */
	interruptRequested?: boolean;
}

type ForegroundInterruptHandler = () => boolean;

type DispatcherState = {
	handlers: Set<ForegroundInterruptHandler>;
	retired: boolean;
	dispatch: () => boolean;
};

const dispatcherStates = new WeakMap<ForegroundInterruptControl, DispatcherState>();

/** Register one active child while preserving the public interrupt callback. */
export function registerForegroundInterrupt(
	control: ForegroundInterruptControl,
	handler: ForegroundInterruptHandler,
): () => void {
	const handlers = control.interruptHandlers ??= new Set<ForegroundInterruptHandler>();
	let state = dispatcherStates.get(control);
	if (!state || state.handlers !== handlers || state.retired) {
		const nextState = {
			handlers,
			retired: false,
			dispatch: undefined as unknown as () => boolean,
		};
		nextState.dispatch = () => {
			if (nextState.retired || dispatcherStates.get(control) !== nextState) return false;
			control.interruptRequested = true;
			let interrupted = false;
			for (const active of [...nextState.handlers]) interrupted = active() || interrupted;
			return interrupted;
		};
		state = nextState;
		dispatcherStates.set(control, state);
	}

	state.handlers.add(handler);
	control.interrupt = state.dispatch;
	let registered = true;
	return () => {
		if (!registered) return;
		registered = false;
		state!.handlers.delete(handler);
		if (state!.handlers.size === 0) {
			state!.retired = true;
			if (control.interrupt === state!.dispatch) control.interrupt = undefined;
			if (dispatcherStates.get(control) === state) dispatcherStates.delete(control);
		}
	};
}
