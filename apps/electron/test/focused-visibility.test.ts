import { it, expect } from 'vitest';
import { FocusedVisibilityGate } from '../src/focused-visibility.js';
it('failed focused navigation cannot activate through a later ordinary paint', () => {
    const gate = new FocusedVisibilityGate();
    gate.begin('failed'); gate.admitted('failed', 2); gate.fail('failed');
    expect(gate.accepts(undefined, 2)).toBe(false); expect(gate.accepts('failed', 2)).toBe(false);
    const previous = gate.begin('replacement'); gate.restore('replacement', previous);
    expect(gate.accepts(undefined, 2)).toBe(false); expect(gate.accepts('failed', 2)).toBe(false);
    gate.begin('new'); gate.admitted('new', 2);
    expect(gate.commit('new', 2)).toBe(true);
});
it('late old paint cannot clear or authorize the new target or generation', () => {
    const gate = new FocusedVisibilityGate();
    gate.begin('old'); gate.admitted('old', 1);
    gate.begin('new'); gate.admitted('new', 2);
    expect(gate.commit('old', 1)).toBe(false);
    expect(gate.accepts('new', 1)).toBe(false);
    expect(gate.commit('new', 2)).toBe(true);
    expect(gate.accepts('old', 1)).toBe(false);
    expect(gate.accepts(undefined, 2)).toBe(true);
});
