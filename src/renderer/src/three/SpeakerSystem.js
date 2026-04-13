import * as THREE from 'three'
import { SPEAKERS, hexToRgb, speakerToCartesian } from '../utils/constants'

export class SpeakerSystem {
  constructor() {
    this.group = new THREE.Group()
    this.speakerMeshes = new Map()
    this.speakerGlows = new Map()
    
    this.createSpeakers()
  }

  createSpeakers() {
    for (const speaker of SPEAKERS) {
      const pos3D = speakerToCartesian(speaker)
      const rgb = hexToRgb(speaker.color)

      // Speaker cube - WIREFRAME to fix occlusion issues
      const isLFE = speaker.id === 'LFE'
      const cubeGeo = isLFE
        ? new THREE.BoxGeometry(0.5, 0.4, 0.5) 
        : new THREE.BoxGeometry(0.15, 0.15, 0.15)
      
      const cubeMat = new THREE.MeshStandardMaterial({
        color: new THREE.Color(rgb.r, rgb.g, rgb.b),
        emissive: new THREE.Color(rgb.r * 0.5, rgb.g * 0.5, rgb.b * 0.5),
        emissiveIntensity: 0.8,
        wireframe: true,
        transparent: true,
        opacity: 0.6,
        depthWrite: false
      })
      const cube = new THREE.Mesh(cubeGeo, cubeMat)
      const yOffset = isLFE ? 0.2 : 0 // Ensure LFE bottom sits perfectly at Y = -1
      cube.position.set(pos3D.x, pos3D.y + yOffset, pos3D.z)
      
      this.group.add(cube)
      this.speakerMeshes.set(speaker.id, cube)

      // Glow sphere
      const glowGeo = new THREE.SphereGeometry(isLFE ? 0.6 : 0.25, 16, 16)
      const glowMat = new THREE.MeshBasicMaterial({
        color: new THREE.Color(rgb.r, rgb.g, rgb.b),
        transparent: true,
        opacity: 0.0,
        blending: THREE.AdditiveBlending,
        depthWrite: false
      })
      const glow = new THREE.Mesh(glowGeo, glowMat)
      glow.position.copy(cube.position)
      this.group.add(glow)
      this.speakerGlows.set(speaker.id, glow)
    }
  }

  updateGains(gains) {
    for (const [spkId, gain] of gains) {
      const glow = this.speakerGlows.get(spkId)
      const cube = this.speakerMeshes.get(spkId)
      if (!glow || !cube) continue

      const intensity = Math.min(1, gain)

      glow.material.opacity = intensity * 0.4
      glow.scale.setScalar(1 + intensity * 0.5)

      const speaker = SPEAKERS.find(s => s.id === spkId)
      if (speaker) {
        const rgb = hexToRgb(speaker.color)
        cube.material.emissive.setRGB(
          rgb.r * intensity,
          rgb.g * intensity,
          rgb.b * intensity
        )
        cube.material.emissiveIntensity = 0.5 + intensity * 2.0
      }
    }
  }

  updateLevels(levels) {
    for (const [spkId, db] of levels) {
      const glow = this.speakerGlows.get(spkId)
      const cube = this.speakerMeshes.get(spkId)
      if (!glow || !cube) continue

      const intensity = Math.max(0, Math.min(1, (db + 60) / 60))

      glow.material.opacity = intensity * 0.3
      glow.scale.setScalar(1 + intensity * 0.3)

      const speaker = SPEAKERS.find(s => s.id === spkId)
      if (speaker) {
        const rgb = hexToRgb(speaker.color)
        cube.material.emissive.setRGB(
           rgb.r * intensity * 0.5,
           rgb.g * intensity * 0.5,
           rgb.b * intensity * 0.5
        )
      }
    }
  }
}
