// src/fx: f1-game js/fx/* (particles, droplets, car-fx, skidmarks, grade-tint), plus the
// three.js sink for the particle and skid batches. The frame order f1-game's game.js
// uses (render(), js/game.js), for the shell to wire:
//
//   once:      fx3 = new FxThree({ mobileTier }); scene.add(fx3.group)
//              particles = createParticles(env); particles.init(fx3)
//              skids = createSkidMarks(); carFx = createCarFx({ vTop, skids, particles })
//              droplets = createDroplets({ ... })
//   race start: skids.reset(); particles.clear()
//   weather:   particles.rainIntensity(k); particles.rainSeed(drizzle); particles.rainShow(on)
//   per frame: particles.update(dt)
//              carFx.haze.pick(cars, player, onboard, track.total, dt)
//              per car: emitters (tyreSmoke / kickup / spray behind sprayAdmit, sparks on
//                       contact), skids.stamp(mat, laying, dt) for the player,
//                       carFx.emit(c, groundMat, dt, state), carFx.haze.mark(c, bodyMat)
//              particles.rainUpdate(dt, eye, raining)   (only while the road is wet)
//              fx3.beginFrame(); skids.draw(fx3, eye); particles.draw()
//              post.haze = carFx.haze.at(viewProj)
//              droplets.tick(paused ? 0 : dt, onboard && !photo, rain, storm, vStd, reduced)
export * from "./env";
export * from "./particles";
export * from "./skidmarks";
export * from "./car-fx";
export * from "./droplets";
export * from "./grade-tint";
export * from "./three";
