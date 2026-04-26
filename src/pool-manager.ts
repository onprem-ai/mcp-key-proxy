import genericPool from "generic-pool";
import { Worker } from "./worker.js";
import { log } from "./logger.js";
import type { Config, PoolStats } from "./types.js";

export class PoolManager {
  private pools = new Map<string, genericPool.Pool<Worker>>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly config: Config) {
    // Periodically clean up empty pools
    this.cleanupTimer = setInterval(() => this.cleanupEmptyPools(), 60000);
    this.cleanupTimer.unref();
  }

  async acquire(
    poolKey: string,
    envVars: Record<string, string>,
  ): Promise<Worker> {
    let pool = this.pools.get(poolKey);
    if (!pool) {
      pool = this.createPool(poolKey, envVars);
      this.pools.set(poolKey, pool);
    }

    const worker = await pool.acquire();

    if (!worker.isAlive()) {
      // Worker died while idle — destroy and get a new one
      await pool.destroy(worker);
      return pool.acquire();
    }

    if (!worker.isInitialized()) {
      try {
        await worker.initialize();
      } catch (err) {
        await pool.destroy(worker);
        throw err;
      }
    }

    return worker;
  }

  release(poolKey: string, worker: Worker): void {
    const pool = this.pools.get(poolKey);
    if (!pool) {
      log.warn("release: pool not found", { poolKey });
      return;
    }
    if (!worker.isAlive()) {
      pool.destroy(worker).catch((err) => {
        log.error("destroy failed", { poolKey, error: (err as Error).message });
      });
      return;
    }
    pool.release(worker).catch((err) => {
      log.error("release failed", { poolKey, error: (err as Error).message });
    });
  }

  getStats(): Record<string, PoolStats> {
    const stats: Record<string, PoolStats> = {};
    for (const [key, pool] of this.pools) {
      stats[key] = {
        size: pool.size,
        available: pool.available,
        borrowed: pool.borrowed,
        pending: pool.pending,
      };
    }
    return stats;
  }

  getTotalWorkers(): number {
    let total = 0;
    for (const pool of this.pools.values()) {
      total += pool.size;
    }
    return total;
  }

  async destroyAll(): Promise<void> {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    const drains = [];
    for (const [key, pool] of this.pools) {
      log.info("draining pool", { poolKey: key });
      drains.push(pool.drain().then(() => pool.clear()));
    }
    await Promise.all(drains);
    this.pools.clear();
  }

  private createPool(
    poolKey: string,
    envVars: Record<string, string>,
  ): genericPool.Pool<Worker> {
    const factory: genericPool.Factory<Worker> = {
      create: async () => {
        log.info("spawning worker", { poolKey });
        const worker = new Worker(this.config.stdioCommand, envVars);
        await worker.start();
        return worker;
      },
      destroy: async (worker) => {
        log.info("destroying worker", { poolKey });
        await worker.destroy();
      },
      validate: async (worker) => {
        return worker.isAlive();
      },
    };

    return genericPool.createPool(factory, {
      max: this.config.poolSize,
      min: 0,
      idleTimeoutMillis: this.config.ttlSeconds * 1000,
      acquireTimeoutMillis: this.config.queueTimeoutSeconds * 1000,
      testOnBorrow: true,
      autostart: false,
    });
  }

  private cleanupEmptyPools(): void {
    for (const [key, pool] of this.pools) {
      if (pool.size === 0 && pool.pending === 0) {
        log.debug("removing empty pool", { poolKey: key });
        pool.drain().then(() => pool.clear()).catch(() => {});
        this.pools.delete(key);
      }
    }
  }
}
