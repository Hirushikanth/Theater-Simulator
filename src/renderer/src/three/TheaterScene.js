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
import { SPEAKERS, speakerToCartesian, ROOM, atmosToRoom, objectColor, hexToRgb, TRAIL_LENGTH } from '../utils/constants'

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

    // Scene objects
    this.speakerMeshes = new Map()
    this.speakerGlows = new Map()
    this.speakerLabels = []
    this.objectMeshes = new Map()
    this.objectTrails = new Map()
    this.connectionLines = []
    this.roomGroup = new THREE.Group()

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
    this.createRoom()
    this.createSpeakers()
    this.createRoomBoundaries()

    // Handle resize
    this._onResize = () => this.onResize()
    window.addEventListener('resize', this._onResize)

    // Start render loop
    this.animate()
  }

  /**
   * Create the room wireframe
   */
  createRoom() {
    const w = ROOM.width / 2
    const h = ROOM.height
    const d = ROOM.depth / 2

    // Room edges with subtle glow
    const edgeMaterial = new THREE.LineBasicMaterial({
      color: 0x1a1a2e,
      transparent: true,
      opacity: 0.4
    })

    // Floor rectangle
    const floorGeo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(-w, -1, -d),
      new THREE.Vector3(w, -1, -d),
      new THREE.Vector3(w, -1, d),
      new THREE.Vector3(-w, -1, d),
      new THREE.Vector3(-w, -1, -d)
    ])
    this.roomGroup.add(new THREE.Line(floorGeo, edgeMaterial))

    // Ceiling rectangle
    const ceilGeo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(-w, h, -d),
      new THREE.Vector3(w, h, -d),
      new THREE.Vector3(w, h, d),
      new THREE.Vector3(-w, h, d),
      new THREE.Vector3(-w, h, -d)
    ])
    this.roomGroup.add(new THREE.Line(ceilGeo, edgeMaterial))

    // Vertical edges
    const corners = [[-w, -d], [w, -d], [w, d], [-w, d]]
    for (const [cx, cz] of corners) {
      const vGeo = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(cx, -1, cz),
        new THREE.Vector3(cx, h, cz)
      ])
      this.roomGroup.add(new THREE.Line(vGeo, edgeMaterial))
    }

    // Semi-transparent floor
    const floorPlane = new THREE.Mesh(
      new THREE.PlaneGeometry(ROOM.width, ROOM.depth),
      new THREE.MeshBasicMaterial({
        color: 0x0a0a14,
        transparent: true,
        opacity: 0.6,
        side: THREE.DoubleSide,
        depthWrite: false
      })
    )
    floorPlane.rotation.x = -Math.PI / 2
    floorPlane.position.y = -1.01
    this.roomGroup.add(floorPlane)

    // Screen at the front
    const screenGeo = new THREE.PlaneGeometry(ROOM.width * 0.8, ROOM.height * 0.5)
    const screenMat = new THREE.MeshBasicMaterial({
      color: 0x0d0d1a,
      transparent: true,
      opacity: 0.8,
      side: THREE.DoubleSide,
      depthWrite: false
    })
    const screen = new THREE.Mesh(screenGeo, screenMat)
    screen.position.set(0, ROOM.height * 0.35, -ROOM.depth / 2 + 0.05)
    this.roomGroup.add(screen)

    // Screen border glow
    const screenBorderGeo = new THREE.EdgesGeometry(screenGeo)
    const screenBorder = new THREE.LineSegments(
      screenBorderGeo,
      new THREE.LineBasicMaterial({ color: 0x1a1a3e, transparent: true, opacity: 0.5 })
    )
    screenBorder.position.copy(screen.position)
    this.roomGroup.add(screenBorder)

    this.scene.add(this.roomGroup)
  }

  /**
   * Create room boundaries (grids)
   */
  createRoomBoundaries() {
    const createGridPlane = (width, height, isFloor = false) => {
      const geo = new THREE.PlaneGeometry(width, height, Math.floor(width * 2), Math.floor(height * 2))
      const mat = new THREE.MeshBasicMaterial({
        color: 0x111122,
        wireframe: true,
        transparent: true,
        opacity: isFloor ? 0.3 : 0.15,
        side: THREE.DoubleSide,
        depthWrite: false
      })
      return new THREE.Mesh(geo, mat)
    }

    // Floor grid plane
    const floorGrid = createGridPlane(ROOM.width, ROOM.depth, true)
    floorGrid.rotation.x = -Math.PI / 2
    floorGrid.position.y = -0.99
    this.scene.add(floorGrid)

    // Walls
    const wallHeight = ROOM.height + 1 // from -1 to 3.5
    const centerY = (ROOM.height - 1) / 2 // 1.25

    // Back wall grid
    const backGrid = createGridPlane(ROOM.width, wallHeight)
    backGrid.position.set(0, centerY, -ROOM.depth / 2)
    this.scene.add(backGrid)

    // Front wall grid
    const frontGrid = createGridPlane(ROOM.width, wallHeight)
    frontGrid.position.set(0, centerY, ROOM.depth / 2)
    this.scene.add(frontGrid)

    // Left wall grid
    const leftGrid = createGridPlane(ROOM.depth, wallHeight)
    leftGrid.rotation.y = Math.PI / 2
    leftGrid.position.set(-ROOM.width / 2, centerY, 0)
    this.scene.add(leftGrid)

    // Right wall grid
    const rightGrid = createGridPlane(ROOM.depth, wallHeight)
    rightGrid.rotation.y = -Math.PI / 2
    rightGrid.position.set(ROOM.width / 2, centerY, 0)
    this.scene.add(rightGrid)
  }

  /**
   * Create speaker cubes with glow indicators
   */
  createSpeakers() {
    for (const speaker of SPEAKERS) {
      const pos3D = speakerToCartesian(speaker)
      const rgb = hexToRgb(speaker.color)

      // Speaker cube
      const isLFE = speaker.id === 'LFE'
      // Draw LFE as a bigger, wider object (subwoofer)
      const cubeGeo = isLFE
        ? new THREE.BoxGeometry(0.5, 0.4, 0.5) 
        : new THREE.BoxGeometry(0.15, 0.15, 0.15)
      
      const cubeMat = new THREE.MeshStandardMaterial({
        color: new THREE.Color(rgb.r, rgb.g, rgb.b),
        emissive: new THREE.Color(rgb.r * 0.2, rgb.g * 0.2, rgb.b * 0.2),
        emissiveIntensity: 0.3,
        metalness: 0.8,
        roughness: 0.2,
        transparent: true,
        opacity: 0.5,
        depthWrite: false
      })
      const cube = new THREE.Mesh(cubeGeo, cubeMat)
      // Shift LFE down so it sits flush on the grid
      const yOffset = isLFE ? 0.2 : 0
      cube.position.set(pos3D.x, pos3D.y + yOffset, pos3D.z)
      
      this.scene.add(cube)
      this.speakerMeshes.set(speaker.id, cube)

      // Glow sphere (larger, semi-transparent)
      const glowGeo = new THREE.SphereGeometry(isLFE ? 0.6 : 0.25, 16, 16)
      const glowMat = new THREE.MeshBasicMaterial({
        color: new THREE.Color(rgb.r, rgb.g, rgb.b),
        transparent: true,
        opacity: 0.0,
        blending: THREE.AdditiveBlending
      })
      const glow = new THREE.Mesh(glowGeo, glowMat)
      glow.position.copy(cube.position)
      this.scene.add(glow)
      this.speakerGlows.set(speaker.id, glow)
    }
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
    for (const [spkId, gain] of gains) {
      const glow = this.speakerGlows.get(spkId)
      const cube = this.speakerMeshes.get(spkId)
      if (!glow || !cube) continue

      const intensity = Math.min(1, gain)

      // Glow opacity
      glow.material.opacity = intensity * 0.4
      glow.scale.setScalar(1 + intensity * 0.5)

      // Cube emissive boost
      const speaker = SPEAKERS.find(s => s.id === spkId)
      if (speaker) {
        const rgb = hexToRgb(speaker.color)
        cube.material.emissive.setRGB(
          rgb.r * intensity,
          rgb.g * intensity,
          rgb.b * intensity
        )
        cube.material.emissiveIntensity = 0.3 + intensity * 1.5
      }
    }
  }

  /**
   * Update speaker glow from audio levels (when no object metadata)
   * @param {Map<string, number>} levels - Speaker ID → dB level
   */
  updateSpeakerLevels(levels) {
    this.speakerLevels = levels
    
    for (const [spkId, db] of levels) {
      const glow = this.speakerGlows.get(spkId)
      const cube = this.speakerMeshes.get(spkId)
      if (!glow || !cube) continue

      // Convert dB to 0-1 intensity
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
