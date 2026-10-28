// Node-only test replacement for the Cloudflare DurableObject base class.
export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'cloudflare:workers') {
    return {
      url:'data:text/javascript,export class DurableObject { constructor(ctx,env) { this.ctx=ctx; this.env=env; } }',
      shortCircuit:true
    };
  }
  return nextResolve(specifier,context);
}
