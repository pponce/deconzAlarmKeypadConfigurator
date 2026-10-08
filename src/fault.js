// Only fixed codes cross a hardware/API boundary. Never propagate device bodies.
export class Fault extends Error {
  constructor(code) { super(code); this.name = 'Fault'; }
}
export function requireValue(condition, code) {
  if (!condition) throw new Fault(code);
}

