import { useEffect, useState } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, test, vi } from 'vitest';
import { OrdinaryObservationSetup } from './OrdinaryObservationSetup';
import type { OrdinarySetup } from './types';

vi.mock('react', async importOriginal => {
 const react = await importOriginal<typeof import('react')>();
 return { ...react, useState: vi.fn(react.useState), useEffect: vi.fn(react.useEffect) };
});
afterEach(() => { vi.mocked(useState).mockReset(); vi.mocked(useEffect).mockReset(); });

test.each(['en', 'ko'] as const)('installation provenance and blocker codes remain in closed %s diagnostics', locale => {
 const status: OrdinarySetup = {
  project_id: 'synthetic-project', configured: true, product: 'claude_code', product_version: 'synthetic-version',
  installation: { state: 'blocked', source: 'available', packageHash: null, installedHash: null,
   destination: '/synthetic/package-destination', receiptDirectory: '/synthetic/receipt-directory',
   hookRegistration: 'unverified', blockers: ['installation_recovery_required'] },
  admission: { profile_id: 'synthetic-profile', admitted: true, qualified: false, max_family_members: 8, model_family: 'claude' },
 };
 let stateIndex = 0;
 vi.mocked(useState).mockImplementation((initial?: unknown) => [stateIndex++ === 0 ? status : initial, () => undefined]);
 vi.mocked(useEffect).mockImplementation(() => undefined);
 const markup = renderToStaticMarkup(OrdinaryObservationSetup({ projectId: status.project_id, locale, busy: false, perform: () => Promise.resolve(null) }));
 const disclosures = [...markup.matchAll(/<details\b([^>]*)>([\s\S]*?)<\/details>/g)];
 expect(disclosures).toHaveLength(1);
 expect(disclosures[0]?.[1]).not.toMatch(/\bopen\b/);
 const primary = markup.replace(/<details\b[^>]*>[\s\S]*?<\/details>/g, '');
 for (const value of [status.installation.destination, status.installation.receiptDirectory, status.installation.hookRegistration]) {
  expect(disclosures[0]?.[2]).toContain(value);
  expect(primary).not.toContain(value);
 }
 expect(disclosures[0]?.[2]).toContain('<code>installation_recovery_required</code>');
 expect(primary).not.toContain('<code>installation_recovery_required</code>');
 expect(primary).toContain('role="alert"');
 expect(primary).toContain('data-admission="true"');
 expect(primary).not.toContain(status.product_version);
});
