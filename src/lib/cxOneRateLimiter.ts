import { Environment } from './environment';
import { log } from './log';
import { RateLimiterMemory, RateLimiterRes } from 'rate-limiter-flexible';
import { sleep } from '../helpers';

export class CXOneRateLimiter {
  private static _instance: RateLimiterMemory;
  private static _keyPrefix = 'cxone';

  private static get() {
    if (!this._instance) {
      this._instance = new RateLimiterMemory({
        duration: Number.parseInt(Environment.getOptional('CXONE_RATE_LIMITER_DURATION', '60')),
        keyPrefix: CXOneRateLimiter._keyPrefix,
        points: Number.parseInt(Environment.getOptional('CXONE_RATE_LIMITER_POINTS', '800')),
      });
    }
    return this._instance;
  }

  public static async consume(points: number) {
    const limiter = CXOneRateLimiter.get();
    await limiter.consume(CXOneRateLimiter._keyPrefix, points);
  }

  public static async waitUntilAPIAvailable(points = 1) {
    let retry = true;
    while (retry) {
      try {
        await CXOneRateLimiter.consume(points);
        retry = false;
      } catch (e) {
        if (!(e instanceof RateLimiterRes)) throw e;
        const waitTime = e.msBeforeNext;
        log.warn(`CXone rate limit exceeded. Retrying in ${waitTime} ms.`);
        await sleep(waitTime);
      }
    }
  }
}
