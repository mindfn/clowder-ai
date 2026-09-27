// Staging that depends on the grown tree's geometry (limbs, perches, fruit
// spots) is computed once here; later acts and the camera read from ctx.

export async function setupStaging(ctx) {
  ctx.shots = null;
  ctx.acts = [];
  ctx.moreFx = [];
  ctx.shakes = [];
}
