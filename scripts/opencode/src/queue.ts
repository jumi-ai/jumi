import { reviewJobKey } from "./review.ts";
import type { ReviewJob } from "./types.ts";
import { errorMessage } from "./util/error.ts";

export interface EnqueueResult {
  key: string;
  queued: boolean;
  /** Follow-up wake recorded as pending behind a queued/leased row. 202, repo-mutex, no new row. */
  deferred?: boolean;
}

export class ReviewQueue<T = ReviewJob> {
  private readonly pending: T[] = [];
  private readonly queuedKeys = new Set<string>();
  private readonly activeKeys = new Set<string>();
  private active = 0;

  constructor(
    private readonly handler: (job: T) => Promise<void>,
    private readonly concurrency = 1,
    private readonly logger: (message: string) => void = console.log,
    private readonly keyOf: (job: T) => string = ((job: T) => reviewJobKey(job as ReviewJob)) as (job: T) => string
  ) {}

  enqueue(job: T): EnqueueResult {
    const key = this.keyOf(job);
    if (this.queuedKeys.has(key) || this.activeKeys.has(key)) {
      return { key, queued: false };
    }

    this.pending.push(job);
    this.queuedKeys.add(key);
    this.drain();
    return { key, queued: true };
  }

  drop(key: string): boolean {
    const index = this.pending.findIndex((job) => this.keyOf(job) === key);
    if (index < 0) return false;
    this.pending.splice(index, 1);
    this.queuedKeys.delete(key);
    return true;
  }

  private drain() {
    while (this.active < this.concurrency && this.pending.length > 0) {
      const job = this.pending.shift();
      if (!job) return;
      void this.run(job);
    }
  }

  private async run(job: T) {
    const key = this.keyOf(job);
    this.queuedKeys.delete(key);
    this.activeKeys.add(key);
    this.active++;

    try {
      await this.handler(job);
      this.logger(`[queue] completed ${key}`);
    } catch (err) {
      this.logger(`[queue] failed ${key}: ${errorMessage(err)}`);
    } finally {
      this.active--;
      this.activeKeys.delete(key);
      this.drain();
    }
  }
}
