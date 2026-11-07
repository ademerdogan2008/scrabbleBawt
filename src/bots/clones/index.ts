// Policies owned by src/bots/clones (03-02); the registry merges this map.
//
// Community clones re-implemented from COMPETITORS.md §4 specs (no upstream code copied):
//   clone:lionel  clone:nijello  clone:lala  clone:sookra  clone:lambi  clone:k13  clone:blackswan
//   clone:field{Shark,Volume,Grinder,Spender,Nibbler}  (Karthik FieldBot presets)
//   clone:{ramp,flat,hunter}                           (Karthik fitted families)
// Data-fitted clones of the live top bots: clone:lucent clone:bron clone:maverick
// Profile-driven clone of any bot in data/profiles.json: profile:<BotName>
import type { PolicyFactory } from '../../core/types.js';
import { createBlackSwan } from './blackswan.js';
import { createBron } from './bron.js';
import { familyFactory } from './families.js';
import { fieldBotFactory } from './fieldbot.js';
import { createK13 } from './k13.js';
import { createLala } from './lala.js';
import { createLambi } from './lambi.js';
import { createLionel } from './lionel.js';
import { createLucent } from './lucent.js';
import { createMaverick } from './maverick.js';
import { createNijello } from './nijello.js';
import { createProfileClone } from './profile.js';
import { createSookra } from './sookra.js';

export const policies: Record<string, PolicyFactory> = {
  'clone:lionel': createLionel,
  'clone:nijello': createNijello,
  'clone:lala': createLala,
  'clone:sookra': createSookra,
  'clone:lambi': createLambi,
  'clone:k13': createK13,
  'clone:blackswan': createBlackSwan,
  'clone:fieldShark': fieldBotFactory('shark'),
  'clone:fieldVolume': fieldBotFactory('volume'),
  'clone:fieldGrinder': fieldBotFactory('grinder'),
  'clone:fieldSpender': fieldBotFactory('spender'),
  'clone:fieldNibbler': fieldBotFactory('nibbler'),
  'clone:ramp': familyFactory('ramp'),
  'clone:flat': familyFactory('flat'),
  'clone:hunter': familyFactory('hunter'),
};

/** Community clones (Task 1 of 03-02), in a stable order. */
export const COMMUNITY_CLONES: readonly string[] = Object.keys(policies);

// Data-fitted clones of the live top bots (COMPETITORS §4.9), calibrated by scripts/zoo-calibrate.ts.
policies['clone:lucent'] = createLucent;
policies['clone:bron'] = createBron;
policies['clone:maverick'] = createMaverick;

export const FITTED_CLONES: readonly string[] = ['clone:lucent', 'clone:bron', 'clone:maverick'];

// Generic profile-driven clone family: 'profile:<BotName>' (registry wildcard, opts.arg = name).
policies['profile:*'] = createProfileClone;
