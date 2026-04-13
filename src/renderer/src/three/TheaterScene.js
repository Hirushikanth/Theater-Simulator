/**
 * Three.js Theater Scene Manager
 *
 * Creates and manages the 3D theater room with:
 * - Room wireframe
 * - Speaker cubes with emissive glow
 * - Dynamic object spheres with color-coded elevation
 * - Movement trails
 * - Connection lines (object → speaker)
 * - OrbitControls for camera
 */

import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { ROOM, atmosToRoom, objectColor, hexToRgb } from '../utils/constants'
import { RoomEnvironment } from './RoomEnvironment'
import { SpeakerSystem } from './SpeakerSystem'

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

    // Scene objects
    this.objectMeshes = new Map()
    this.objectTrails = new Map()
    this.connectionLines = []

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

    // Ambient lighting
    const ambient = new THREE.AmbientLight(0x111122, 0.5)
    this.scene.add(ambient)

    // Subtle directional light
    const dirLight = new THREE.DirectionalLight(0x334466, 0.3)
    dirLight.position.set(5, 10, 5)
    this.scene.add(dirLight)

    // Build scene
    this.room = new RoomEnvironment()
    this.scene.add(this.room.group)

    this.speakers = new SpeakerSystem()
    this.scene.add(this.speakers.group)

    // Handle resize
    this._onResize = () => this.onResize()
    window.addEventListener('resize', this._onResize)

    // Start render loop
    this.animate()
  }

  /**
   * Update object spheres from metadata
   * @param {Array} objects - Array of {id, x, y, z, size, gain, confidence}
   */
  updateObjects(objects) {
    const activeIds = new Set()

    for (const obj of objects) {
      activeIds.add(obj.id)
      const roomPos = atmosToRoom(obj.x, obj.y, obj.z)

      if (this.objectMeshes.has(obj.id)) {
        // Update existing object
        const mesh = this.objectMeshes.get(obj.id)
        mesh.position.lerp(
          new THREE.Vector3(roomPos.x, roomPos.y, roomPos.z),
          0.3
        )

        // Update color based on elevation
        const color = objectColor(obj.z)
        const rgb = hexToRgb(color)
        mesh.material.color.setRGB(rgb.r, rgb.g, rgb.b)
        mesh.material.emissive.setRGB(rgb.r * 0.5, rgb.g * 0.5, rgb.b * 0.5)
        mesh.material.opacity = 0.4 + (obj.gain || 0.8) * 0.6

        // Update size
        const scale = 0.08 + (obj.size || 0.05) * 0.3
        mesh.scale.setScalar(scale / 0.1)
      } else {
        // Create new object sphere
        this.createObjectMesh(obj, roomPos)
      }
    }

    // Remove objects no longer present
    for (const [id, mesh] of this.objectMeshes) {
      if (!activeIds.has(id)) {
        // Fade out
        mesh.material.opacity *= 0.9
        if (mesh.material.opacity < 0.01) {
          this.scene.remove(mesh)
          this.objectMeshes.delete(id)
        }
      }
    }
  }

  /**
   * Create a new 3D object mesh
   */
  createObjectMesh(obj, roomPos) {
    const color = objectColor(obj.z)
    const rgb = hexToRgb(color)
    const size = 0.08 + (obj.size || 0.05) * 0.3

    const geo = new THREE.SphereGeometry(0.1, 24, 24)
    const mat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(rgb.r, rgb.g, rgb.b),
      emissive: new THREE.Color(rgb.r * 0.5, rgb.g * 0.5, rgb.b * 0.5),
      emissiveIntensity: 0.8,
      metalness: 0.3,
      roughness: 0.4,
      transparent: true,
      opacity: 0.8
    })

    const mesh = new THREE.Mesh(geo, mat)
    mesh.position.set(roomPos.x, roomPos.y, roomPos.z)
    mesh.scale.setScalar(size / 0.1)
    mesh.renderOrder = 2

    this.scene.add(mesh)
    this.objectMeshes.set(obj.id, mesh)
  }


  /**
   * Update speaker glow based on VBAP gains
   * @param {Map<string, number>} gains - Speaker ID → gain (0-1)
   */
  updateSpeakerGains(gains) {
    this.speakerGains = gains
    if (this.speakers) {
      this.speakers.updateGains(gains)
    }
  }

  /**
   * Update speaker glow from audio levels (when no object metadata)
   * @param {Map<string, number>} levels - Speaker ID → dB level
   */
  updateSpeakerLevels(levels) {
    this.speakerLevels = levels
    if (this.speakers) {
      this.speakers.updateLevels(levels)
    }
  }

  /**
   * Animation loop
   */
  animate() {
    this.animationFrame = requestAnimationFrame(() => this.animate())
    
    // Smoothly update speaker levels natively in ThreeJS
    if (this.speakerLevels.size > 0 && this.speakerGains.size === 0) {
      // Re-run the update logic if we haven't already this frame
      // In a real high-perf scenario, we'd move the loop here
      this.updateSpeakerLevels(this.speakerLevels)
    }

    this.controls.update()
    this.renderer.render(this.scene, this.camera)
  }

  /**
   * Handle window resize
   */
  onResize() {
    this.width = this.container.clientWidth
    this.height = this.container.clientHeight
    this.camera.aspect = this.width / this.height
    this.camera.updateProjectionMatrix()
    this.renderer.setSize(this.width, this.height)
  }

  /**
   * Get the number of active objects
   */
  getActiveObjectCount() {
    return this.objectMeshes.size
  }

  /**
   * Cleanup
   */
  destroy() {
    if (this.animationFrame) {
      cancelAnimationFrame(this.animationFrame)
    }
    window.removeEventListener('resize', this._onResize)

    // Dispose geometries and materials
    this.scene.traverse(obj => {
      if (obj.geometry) obj.geometry.dispose()
      if (obj.material) {
        if (Array.isArray(obj.material)) {
          obj.material.forEach(m => m.dispose())
        } else {
          obj.material.dispose()
        }
      }
    })

    this.renderer.dispose()
    if (this.renderer.domElement.parentNode) {
      this.renderer.domElement.parentNode.removeChild(this.renderer.domElement)
    }
  }
}
