/**
 * Three.js Theater Scene Manager
 *
 * Implements a high-performance Object Pool for Atmos spheres.
 * Pre-allocating 128 spheres prevents Garbage Collection stutter
 * during heavy metadata object churn.
 */

import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { ROOM, atmosToRoom, objectColor, hexToRgb } from '../utils/constants'
import { RoomEnvironment } from './RoomEnvironment'
import { SpeakerSystem } from './SpeakerSystem'

const MAX_ATMOS_OBJECTS = 128

export class TheaterScene {
  constructor(container) {
    this.container = container
    this.width = container.clientWidth
    this.height = container.clientHeight

    // Three.js core
    this.scene = new THREE.Scene()
    this.camera = null
    this.renderer = null
    this.controls = null

    // Modular subsystem controllers
    this.room = null
    this.speakers = null

    // High-Performance Object Pool
    this.sharedSphereGeo = new THREE.SphereGeometry(0.1, 24, 24)
    this.objectPool = []
    this.activeMeshes = new Map() // Maps metadata ID -> pooled Mesh

    this.speakerGains = new Map()
    this.speakerLevels = new Map()
    this.animationFrame = null

    this.init()
  }

  init() {
    // Renderer
    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: true,
      powerPreference: 'high-performance'
    })
    this.renderer.setSize(this.width, this.height)
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.renderer.setClearColor(0x000000, 0)
    this.renderer.outputColorSpace = THREE.SRGBColorSpace
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.toneMappingExposure = 1.2
    this.container.appendChild(this.renderer.domElement)

    // Camera
    this.camera = new THREE.PerspectiveCamera(50, this.width / this.height, 0.1, 100)
    this.camera.position.set(0, 5, 8)
    this.camera.lookAt(0, 1, 0)

    // Controls
    this.controls = new OrbitControls(this.camera, this.renderer.domElement)
    this.controls.enableDamping = true
    this.controls.dampingFactor = 0.08
    this.controls.minDistance = 3
    this.controls.maxDistance = 20
    this.controls.maxPolarAngle = Math.PI * 0.85
    this.controls.target.set(0, 1.2, 0)
    this.controls.update()

    // Ambient & Directional lighting
    const ambient = new THREE.AmbientLight(0x111122, 0.5)
    this.scene.add(ambient)

    const dirLight = new THREE.DirectionalLight(0x334466, 0.3)
    dirLight.position.set(5, 10, 5)
    this.scene.add(dirLight)

    // Build static scene
    this.room = new RoomEnvironment()
    this.scene.add(this.room.group)

    this.speakers = new SpeakerSystem()
    this.scene.add(this.speakers.group)

    // Pre-allocate the dynamic object pool
    this.initObjectPool()

    // Handle resize
    this._onResize = () => this.onResize()
    window.addEventListener('resize', this._onResize)

    // Start render loop
    this.animate()
  }

  /**
   * Pre-allocates meshes to completely eliminate Garbage Collection during playback.
   */
  initObjectPool() {
    for (let i = 0; i < MAX_ATMOS_OBJECTS; i++) {
      const mat = new THREE.MeshStandardMaterial({
        color: 0xffffff,
        emissive: 0x000000,
        emissiveIntensity: 0.8,
        metalness: 0.3,
        roughness: 0.4,
        transparent: true,
        opacity: 0
      })

      const mesh = new THREE.Mesh(this.sharedSphereGeo, mat)
      mesh.visible = false
      mesh.renderOrder = 2
      
      this.scene.add(mesh)
      this.objectPool.push(mesh)
    }
  }

  /**
   * Maps incoming metadata objects to physical meshes using the pool
   * @param {Array} objects - Array of {id, x, y, z, size, gain, confidence}
   */
  updateObjects(objects) {
    const incomingIds = new Set()

    for (const obj of objects) {
      incomingIds.add(obj.id)
      const roomPos = atmosToRoom(obj.x, obj.y, obj.z)
      
      let mesh = this.activeMeshes.get(obj.id)

      // 1. Claim a mesh from the pool if this object is new
      if (!mesh) {
        if (this.objectPool.length === 0) continue // Sanity check (max 128)
        
        mesh = this.objectPool.pop()
        mesh.visible = true
        mesh.material.opacity = 0 // Start invisible, fade in
        // Snap directly to position on spawn so it doesn't "fly in" from 0,0,0
        mesh.position.set(roomPos.x, roomPos.y, roomPos.z) 
        
        this.activeMeshes.set(obj.id, mesh)
      }

      // 2. Update mesh spatial properties (raw position, no smoothing)
      mesh.position.set(roomPos.x, roomPos.y, roomPos.z)

      // 3. Update Colors based on elevation
      const color = objectColor(obj.z)
      const rgb = hexToRgb(color)
      mesh.material.color.setRGB(rgb.r, rgb.g, rgb.b)
      mesh.material.emissive.setRGB(rgb.r * 0.5, rgb.g * 0.5, rgb.b * 0.5)

      // Smooth opacity transitions (fade in)
      const targetOpacity = 0.4 + (obj.gain || 0.8) * 0.6
      mesh.material.opacity = mesh.material.opacity * 0.7 + targetOpacity * 0.3

      // Size scaling
      const scale = 0.08 + (obj.size || 0.05) * 0.3
      mesh.scale.setScalar(scale / 0.1)
    }

    // 4. Handle fade-outs and returning objects to the pool
    for (const [id, mesh] of this.activeMeshes) {
      if (!incomingIds.has(id)) {
        // Fast fade out
        mesh.material.opacity *= 0.80 
        
        // Once invisible, return to pool
        if (mesh.material.opacity < 0.01) {
          mesh.visible = false
          this.activeMeshes.delete(id)
          this.objectPool.push(mesh)
        }
      }
    }
  }

  updateSpeakerGains(gains) {
    this.speakerGains = gains
    if (this.speakers) {
      this.speakers.updateGains(gains)
    }
  }

  updateSpeakerLevels(levels) {
    this.speakerLevels = levels
    if (this.speakers) {
      this.speakers.updateLevels(levels)
    }
  }

  animate() {
    this.animationFrame = requestAnimationFrame(() => this.animate())
    
    // Fallback native level loop if no spatial gains are overriding it
    if (this.speakerLevels.size > 0 && this.speakerGains.size === 0) {
      this.updateSpeakerLevels(this.speakerLevels)
    }

    this.controls.update()
    this.renderer.render(this.scene, this.camera)
  }

  onResize() {
    this.width = this.container.clientWidth
    this.height = this.container.clientHeight
    this.camera.aspect = this.width / this.height
    this.camera.updateProjectionMatrix()
    this.renderer.setSize(this.width, this.height)
  }

  getActiveObjectCount() {
    return this.activeMeshes.size
  }

  destroy() {
    if (this.animationFrame) {
      cancelAnimationFrame(this.animationFrame)
    }
    window.removeEventListener('resize', this._onResize)

    // Fast disposal loop
    this.sharedSphereGeo.dispose()
    this.scene.traverse(obj => {
      if (obj.geometry && obj.geometry !== this.sharedSphereGeo) obj.geometry.dispose()
      if (obj.material) {
        if (Array.isArray(obj.material)) obj.material.forEach(m => m.dispose())
        else obj.material.dispose()
      }
    })

    this.renderer.dispose()
    if (this.renderer.domElement.parentNode) {
      this.renderer.domElement.parentNode.removeChild(this.renderer.domElement)
    }
  }
}