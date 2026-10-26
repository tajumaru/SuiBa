export interface LoginAttempt {
  generation: number;
  signal: AbortSignal;
}

/** Synchronous single-flight guard, independent of React's render scheduling. */
export class LoginAttempts {
  private generation = 0;
  private active: AbortController | null = null;
  private completed = false;

  begin(): LoginAttempt | null {
    if (this.active || this.completed) return null;
    this.active = new AbortController();
    return { generation: ++this.generation, signal: this.active.signal };
  }

  current(attempt: LoginAttempt): boolean {
    return this.active !== null && attempt.generation === this.generation;
  }

  release(attempt: LoginAttempt): boolean {
    if (!this.current(attempt)) return false;
    this.active = null;
    return true;
  }

  complete(attempt: LoginAttempt): boolean {
    if (!this.release(attempt)) return false;
    this.completed = true;
    return true;
  }

  invalidate(): void {
    ++this.generation;
    const active = this.active;
    this.active = null;
    this.completed = false;
    active?.abort();
  }
}
