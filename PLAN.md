# Moto-X3M Style Physics Stunt Game Plan

## Goal
Elevate the platform's default action template from a simple geometry-based Flappy Bird / Shooter to a polished, high-quality physics stunt motorcycle game ("Stunt Rider X") inspired by web classic pacing and challenge loops.

## Core Pillars
1. **Motorcycle Physics & Tilt Control**: Realistic angular velocity, suspension damping, throttle, and air-rotation control. Tipping over or crashing resets the checkpoint with immediate restart.
2. **Hazard-rich Levels**: Moving saw blades, collapsing bridges, spikes, and turbo booster pads across structured multi-segment terrain.
3. **Juicy Feedback & UI**: Particle dust trails, explosion sparks on crash, star rating based on completion time, and smooth camera follow.
4. **Multi-file Phaser + Vite Architecture**: Fully modularized classes under `src/entities/`, `src/scenes/`, and `src/physics/`.
