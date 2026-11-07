// Policies owned by src/bots/clones (03-02); the registry merges this map.
//
// Community clones re-implemented from COMPETITORS.md §4 specs (no upstream code copied):
//   clone:lionel  clone:nijello  clone:lala  clone:sookra  clone:lambi  clone:k13  clone:blackswan
//   clone:field{Shark,Volume,Grinder,Spender,Nibbler}  (Karthik FieldBot presets)
//   clone:{ramp,flat,hunter}                           (Karthik fitted families)
import type { PolicyFactory } from '../../core/types.js';
import { createBlackSwan } from './blackswan.js';
import { familyFactory } from './families.js';
import { fieldBotFactory } from './fieldbot.js';
import { createK13 } from './k13.js';
import { createLala } from './lala.js';
import { createLambi } from './lambi.js';
import { createLionel } from './lionel.js';
import { createNijello } from './nijello.js';
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
