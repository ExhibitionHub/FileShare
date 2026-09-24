export class CapacityExceededError extends Error {
  constructor(message = "Service temporairement saturé.") {
    super(message);
    this.code = "overloaded";
  }
}

export class CapacityGate {
  constructor({ maxActive, maxQueued, waitTimeoutMs }) {
    this.maxActive = maxActive;
    this.maxQueued = maxQueued;
    this.waitTimeoutMs = waitTimeoutMs;
    this.active = 0;
    this.queue = [];
  }

  stats() {
    return { active: this.active, queued: this.queue.length, maxActive: this.maxActive, maxQueued: this.maxQueued };
  }

  acquire() {
    if (this.active < this.maxActive) {
      this.active += 1;
      return Promise.resolve(this.releaseFunction());
    }
    if (this.queue.length >= this.maxQueued) {
      return Promise.reject(new CapacityExceededError());
    }
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject, timer: null };
      entry.timer = setTimeout(() => {
        const index = this.queue.indexOf(entry);
        if (index >= 0) this.queue.splice(index, 1);
        reject(new CapacityExceededError("Temps d'attente dépassé."));
      }, this.waitTimeoutMs);
      entry.timer.unref?.();
      this.queue.push(entry);
    });
  }

  releaseFunction() {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.queue.shift();
      if (next) {
        clearTimeout(next.timer);
        next.resolve(this.releaseFunction());
      } else {
        this.active -= 1;
      }
    };
  }
}
