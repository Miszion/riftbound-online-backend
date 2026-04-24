import logger from '../logger';
import type { EffectOp, OpHandler } from './types';

/**
 * Thin Map wrapper keyed on op.type. No fancy metadata - the dispatcher
 * is the only consumer and needs O(1) lookup + a warn path when a type
 * has no handler registered.
 */
export class OpHandlerRegistry {
  private readonly handlers = new Map<string, OpHandler<EffectOp>>();

  register<T extends EffectOp>(handler: OpHandler<T>): void {
    this.handlers.set(handler.op, handler as unknown as OpHandler<EffectOp>);
  }

  /**
   * Skip nullish entries with a warn rather than crashing the registry.
   * A missing barrel export should degrade to "op unhandled" at dispatch,
   * not take the whole engine down at boot.
   */
  registerAll(handlers: Array<OpHandler<EffectOp> | undefined | null>): void {
    for (const h of handlers) {
      if (!h) {
        logger.warn('[effects] registerAll received nullish handler, skipping', {
          event: 'OP_REGISTRY_SKIPPED_UNDEFINED'
        });
        continue;
      }
      this.handlers.set(h.op, h);
    }
  }

  get(opType: string): OpHandler<EffectOp> | undefined {
    return this.handlers.get(opType);
  }

  has(opType: string): boolean {
    return this.handlers.has(opType);
  }

  listTypes(): string[] {
    return Array.from(this.handlers.keys()).sort();
  }
}
