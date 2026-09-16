import {
  allowedTransitions,
  canTransition,
  transitionDetail,
} from './job-status';

describe('job status machine', () => {
  it('allows pending to running or failed', () => {
    expect(allowedTransitions('pending')).toEqual(['running', 'failed']);
    expect(canTransition('pending', 'running')).toBe(true);
    expect(canTransition('pending', 'failed')).toBe(true);
  });

  it('allows running to completed or failed', () => {
    expect(canTransition('running', 'completed')).toBe(true);
    expect(canTransition('running', 'failed')).toBe(true);
    expect(canTransition('running', 'pending')).toBe(false);
  });

  it('treats completed and failed as terminal', () => {
    expect(allowedTransitions('completed')).toEqual([]);
    expect(allowedTransitions('failed')).toEqual([]);
    expect(canTransition('completed', 'running')).toBe(false);
    expect(canTransition('failed', 'running')).toBe(false);
    expect(canTransition('completed', 'pending')).toBe(false);
  });

  it('explains why a terminal job cannot restart', () => {
    expect(transitionDetail('completed', 'running')).toMatch(
      /cannot become running/i,
    );
    expect(transitionDetail('failed', 'running')).toMatch(
      /cannot become running/i,
    );
  });
});
