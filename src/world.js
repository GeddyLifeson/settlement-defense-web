// Ported from SD.Headless/SimWorld.cs -- the composition root that owns every store/system
// and advances them one fixed tick at a time (10 Hz, matching ARCHITECTURE.md section 2).
import { makeRng, AggressionPreset, StaffRoleKind } from './core.js';
import { SettlementGrid } from './grid.js';
import { CitizenStore, tickNeedsAndMood, tickWander, CitizenFlags } from './citizens.js';
import { StaffRoster, tickStaffDuty, tickDogs } from './security.js';
import {
  AttackerStore, Structure, WaveSpawner, tickAttackers, tickTurrets,
  tickAttackerVsCitizens, tickStaffCombat,
} from './siege.js';
import { ZoneGrid, ZoneKind } from './zones.js';
import { tickJobs, isOnJob } from './jobs.js';
import { RelationshipWeb } from './relationships.js';
import { directWaveSpawner } from './director.js';
import { TRAITS } from './traits.js';
import { scatterNodes, maybeSpawnNode, ResourceNode } from './resources.js';
import { maybeSpawnVehicle, tickVehicles } from './vehicles.js';

const STARTER_NAMES = [
  'Marlon', 'Aisling', 'Niamh', 'Reeli', 'Cascade', 'Orrery', 'Motoko',
  'Briar', 'Ansel', 'Sable', 'Quinn', 'Vesper', 'Rowan', 'Isolde', 'Callan',
  'Freya', 'Bram', 'Elowen', 'Tavish', 'Maren', 'Cormac', 'Sorcha', 'Declan', 'Aoife',
];

export class SimWorld {
  constructor(width, height, seed, aggression = AggressionPreset.Calm, startingCitizens = 24) {
    this.width = width;
    this.height = height;
    this.seed = seed;
    this.aggression = aggression;
    this.rng = makeRng(seed);
    this.currentTick = 0;
    this.paused = false;
    this.gameOver = false;
    this.milestoneLog = [];

    this.grid = new SettlementGrid(width, height);
    this.zones = new ZoneGrid(width, height);
    this.citizens = new CitizenStore(64);
    this.attackers = new AttackerStore(1024);
    this.roster = new StaffRoster();
    this.structures = [];
    this.waveSpawner = new WaveSpawner(this.grid);
    this.relationships = new RelationshipWeb();
    this.scrap = 50;
    this._lastWaveLogged = 0;

    const count = Math.min(startingCitizens, STARTER_NAMES.length);
    this._citizenIds = [];
    for (let n = 0; n < count; n++) {
      const x = 15 + (n % 8) * 2;
      const y = 15 + Math.floor(n / 8) * 2;
      const idx = this.citizens.spawn(STARTER_NAMES[n], x, y, this.rng);
      this._citizenIds.push(this.citizens.id[idx]);
    }

    this.dogs = [];
    if (count > 3) {
      this.roster.assign(this._citizenIds[0], StaffRoleKind.Sniper, { x: 13, y: 20 });
      this.roster.assign(this._citizenIds[1], StaffRoleKind.Sniper, { x: 29, y: 20 });
      this.roster.assign(this._citizenIds[2], StaffRoleKind.Guard, { x: 21, y: 13 });
      this.roster.assign(this._citizenIds[3], StaffRoleKind.Guard, { x: 21, y: 27 });
    }
    if (count > 4) {
      this.roster.assign(this._citizenIds[4], StaffRoleKind.K9Handler, { x: 21, y: 20 });
      this.dogs.push({ ownerId: this._citizenIds[4], x: 21, y: 20, cooldown: 0 });
    }

    for (const [tx, ty] of [[13, 20], [29, 20], [21, 13], [21, 27]]) {
      this.structures.push(new Structure('turret', tx, ty, { instant: true }));
    }

    // Default zones so the job system has somewhere to send citizens out of the box.
    for (let x = 17; x <= 20; x++) for (let y = 17; y <= 20; y++) this.zones.set(x, y, ZoneKind.Food);
    for (let x = 22; x <= 25; x++) for (let y = 17; y <= 20; y++) this.zones.set(x, y, ZoneKind.Bedroom);
    for (let x = 17; x <= 20; x++) for (let y = 22; y <= 23; y++) this.zones.set(x, y, ZoneKind.Recreation);

    this.resourceNodes = scatterNodes(this.grid, this.rng, 16, 14, this.width / 2, this.height / 2);
    this.vehicles = [];
    this._nextVehicleTick = 200;
  }

  idOf(i) { return this.citizens.id[i]; }
  isStaffAt(i) { return this.roster.isStaff(this.citizens.id[i]); }

  addScrap(amount) { this.scrap += amount; }

  build(kind, x, y) {
    this.structures.push(new Structure(kind, x, y));
  }

  tick() {
    if (this.paused || this.gameOver) return;
    this.currentTick++;

    tickNeedsAndMood(this.citizens, (i) => this.isStaffAt(i), this.rng);
    tickJobs(this.citizens, this.zones, (i) => this.isStaffAt(i), this.structures, this.resourceNodes,
      (i) => this.idOf(i), (amt) => this.addScrap(amt));
    tickStaffDuty(this.citizens, this.roster, (i) => this.idOf(i));
    tickWander(this.citizens, this.grid, this.rng, 0.04, (i) => this.isStaffAt(i) || isOnJob(this.citizens, i));
    tickDogs(this.dogs, this.citizens, this.roster, this.attackers, (amt) => this.addScrap(amt));
    this.relationships.tick(this.citizens, (i) => this.citizens.name[i], this.currentTick);

    maybeSpawnNode(this.resourceNodes, this.grid, this.rng, this.currentTick, this.width / 2, this.height / 2);
    maybeSpawnVehicle(this);
    tickVehicles(this);

    directWaveSpawner(this);
    this.waveSpawner.tick(this.currentTick, this.attackers, this.rng);
    tickAttackers(this.attackers, this.structures, this.grid, this.width / 2, this.height / 2, this.citizens, (amt) => this.addScrap(amt));
    tickTurrets(this.structures, this.attackers, (amt) => this.addScrap(amt));
    tickStaffCombat(this.citizens, this.roster, (i) => this.idOf(i), this.attackers, (amt) => this.addScrap(amt));
    tickAttackerVsCitizens(this.attackers, this.citizens);

    // Wall blueprints live in this.structures like everything else (for the ghost render +
    // construction progress), but the actual passability/terrain effect lives on the grid --
    // apply it the tick a wall blueprint finishes, then drop the now-redundant entry.
    this.structures = this.structures.filter(s => {
      if (s.kind === 'wall' && !s.underConstruction) {
        this.grid.setWall(Math.floor(s.x), Math.floor(s.y), 1);
        return false;
      }
      return true;
    });

    if (this.waveSpawner.waveNumber > this._lastWaveLogged) {
      this._lastWaveLogged = this.waveSpawner.waveNumber;
      this.milestoneLog.push({ tick: this.currentTick, text: `Wave ${this.waveSpawner.waveNumber} incoming` });
      if (this.milestoneLog.length > 20) this.milestoneLog.shift();
    }

    let aliveCitizens = 0;
    for (let i = 0; i < this.citizens.count; i++) if (this.citizens.isAliveAt(i)) aliveCitizens++;
    if (aliveCitizens === 0 && this.citizens.count > 0) {
      this.gameOver = true;
      this.milestoneLog.push({ tick: this.currentTick, text: 'GAME OVER -- the settlement has fallen' });
    }
  }

  serialize() {
    return {
      width: this.width, height: this.height, seed: this.seed, aggression: this.aggression,
      currentTick: this.currentTick, scrap: this.scrap, gameOver: this.gameOver,
      waveNumber: this.waveSpawner.waveNumber, nextWaveTick: this.waveSpawner.nextWaveTick,
      citizens: {
        count: this.citizens.count,
        id: Array.from(this.citizens.id.slice(0, this.citizens.count)),
        name: this.citizens.name.slice(0, this.citizens.count),
        x: Array.from(this.citizens.x.slice(0, this.citizens.count)),
        y: Array.from(this.citizens.y.slice(0, this.citizens.count)),
        hunger: Array.from(this.citizens.hunger.slice(0, this.citizens.count)),
        rest: Array.from(this.citizens.rest.slice(0, this.citizens.count)),
        social: Array.from(this.citizens.social.slice(0, this.citizens.count)),
        mood: Array.from(this.citizens.mood.slice(0, this.citizens.count)),
        health: Array.from(this.citizens.health.slice(0, this.citizens.count)),
        alive: Array.from(this.citizens.alive.slice(0, this.citizens.count)),
        flags: Array.from(this.citizens.flags.slice(0, this.citizens.count)),
        skillCombat: Array.from(this.citizens.skillCombat.slice(0, this.citizens.count)),
        skillConstruction: Array.from(this.citizens.skillConstruction.slice(0, this.citizens.count)),
        trait: this.citizens.trait.slice(0, this.citizens.count).map(t => t?.name ?? null),
      },
      roster: Array.from(this.roster._roleById.entries()).map(([id, kind]) => ({
        id, kind, post: this.roster._postById.get(id) || null,
      })),
      structures: this.structures.map(s => ({
        kind: s.kind, x: s.x, y: s.y, health: s.health, destroyed: s.destroyed,
        underConstruction: s.underConstruction, buildProgress: s.buildProgress,
      })),
      zones: Array.from(this.zones.kind),
      dogs: this.dogs.map(d => ({ ownerId: d.ownerId, x: d.x, y: d.y })),
      resourceNodes: this.resourceNodes.map(n => ({ x: n.x, y: n.y, amount: n.amount, maxAmount: n.maxAmount, depleted: n.depleted })),
    };
  }

  static deserialize(json) {
    const w = new SimWorld(json.width, json.height, json.seed, json.aggression, 0);
    w.currentTick = json.currentTick;
    w.scrap = json.scrap;
    w.gameOver = json.gameOver || false;
    w.waveSpawner.waveNumber = json.waveNumber || 0;
    w.waveSpawner.nextWaveTick = json.nextWaveTick || 300;
    const c = json.citizens;
    w.citizens.count = c.count;
    for (let i = 0; i < c.count; i++) {
      w.citizens.id[i] = c.id[i];
      w.citizens.name[i] = c.name[i];
      w.citizens.x[i] = c.x[i]; w.citizens.y[i] = c.y[i];
      w.citizens.targetX[i] = c.x[i]; w.citizens.targetY[i] = c.y[i];
      w.citizens.hunger[i] = c.hunger[i]; w.citizens.rest[i] = c.rest[i]; w.citizens.social[i] = c.social[i];
      w.citizens.mood[i] = c.mood[i]; w.citizens.health[i] = c.health[i]; w.citizens.alive[i] = c.alive[i];
      w.citizens.flags[i] = c.flags ? c.flags[i] : 0;
      w.citizens.skillCombat[i] = c.skillCombat ? c.skillCombat[i] : 0;
      w.citizens.skillConstruction[i] = c.skillConstruction ? c.skillConstruction[i] : 0;
      w.citizens.trait[i] = c.trait && c.trait[i] ? TRAITS.find(t => t.name === c.trait[i]) : null;
    }
    w.roster = new (Object.getPrototypeOf(w.roster).constructor)();
    for (const r of json.roster) w.roster.assign(r.id, r.kind, r.post);
    w.structures = json.structures.map(s => Object.assign(new Structure(s.kind, s.x, s.y, { instant: true }), s));
    if (json.zones) w.zones.kind.set(json.zones);
    if (json.dogs) w.dogs = json.dogs.map(d => ({ ...d, cooldown: 0 }));
    if (json.resourceNodes) {
      w.resourceNodes = json.resourceNodes.map(n => Object.assign(new ResourceNode(n.x, n.y, n.maxAmount), n));
    }
    w.vehicles = [];
    return w;
  }
}
