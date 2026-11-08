import profileData from '../../src/core/tool-version-profiles.json' with { type: 'json' };
import recipeData from '../../src/core/tool-version-recipes.json' with { type: 'json' };
import identityData from '../../src/core/tool-version-identities.json' with { type: 'json' };
import { promotionRegistryDigest } from '../../src/core/tool-version-promotion.js';
import { promotionFixture } from './tool-version-promotion.js';

export function promotionRegistryFixture(product: 'codex' | 'claude_code' = 'codex') {
  const fixture = promotionFixture(product);
  const descriptor = fixture.descriptors[0];
  if (!descriptor) throw new Error('synthetic_descriptor_required');
  const template = recipeData.find(recipe => recipe.product === product && recipe.kind === (product === 'codex' ? 'codex_binding' : 'claude_localhost'));
  const image = identityData.entries.find(identity => identity.product === product && identity.kind === 'native_image');
  if (!template || !image) throw new Error('synthetic_reference_required');
  const recipe = {
    ...Object.fromEntries(Object.entries(template).filter(([key]) => key !== 'hostIdentity')),
    id: descriptor.recipeReferences[0],
    version: descriptor.version,
    imageIdentity: descriptor.nativeIdentity
  };
  const registry = {
    profiles: [...profileData, descriptor],
    recipes: [...recipeData, recipe],
    identities: [
      ...identityData.entries,
      {
        ...image,
        id: descriptor.nativeIdentity,
        version: descriptor.version,
        sha256: '5'.repeat(64)
      }
    ]
  };
  fixture.registryDigest = promotionRegistryDigest(registry);
  return { ...fixture, registry };
}
