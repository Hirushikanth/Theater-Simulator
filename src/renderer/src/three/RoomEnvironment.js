import * as THREE from 'three'
import { ROOM } from '../utils/constants'

export class RoomEnvironment {
  constructor() {
    this.group = new THREE.Group()
    this.createRoom()
    this.createRoomBoundaries()
  }

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
    this.group.add(new THREE.Line(floorGeo, edgeMaterial))

    // Ceiling rectangle
    const ceilGeo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(-w, h, -d),
      new THREE.Vector3(w, h, -d),
      new THREE.Vector3(w, h, d),
      new THREE.Vector3(-w, h, d),
      new THREE.Vector3(-w, h, -d)
    ])
    this.group.add(new THREE.Line(ceilGeo, edgeMaterial))

    // Vertical edges
    const corners = [[-w, -d], [w, -d], [w, d], [-w, d]]
    for (const [cx, cz] of corners) {
      const vGeo = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(cx, -1, cz),
        new THREE.Vector3(cx, h, cz)
      ])
      this.group.add(new THREE.Line(vGeo, edgeMaterial))
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
    this.group.add(floorPlane)

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
    this.group.add(screen)

    // Screen border glow
    const screenBorderGeo = new THREE.EdgesGeometry(screenGeo)
    const screenBorder = new THREE.LineSegments(
      screenBorderGeo,
      new THREE.LineBasicMaterial({ color: 0x1a1a3e, transparent: true, opacity: 0.5 })
    )
    screenBorder.position.copy(screen.position)
    this.group.add(screenBorder)
  }

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
    this.group.add(floorGrid)

    // Walls
    const wallHeight = ROOM.height + 1 // from -1 to 3.5
    const centerY = (ROOM.height - 1) / 2 // 1.25

    // Back wall grid
    const backGrid = createGridPlane(ROOM.width, wallHeight)
    backGrid.position.set(0, centerY, -ROOM.depth / 2)
    this.group.add(backGrid)

    // Front wall grid
    const frontGrid = createGridPlane(ROOM.width, wallHeight)
    frontGrid.position.set(0, centerY, ROOM.depth / 2)
    this.group.add(frontGrid)

    // Left wall grid
    const leftGrid = createGridPlane(ROOM.depth, wallHeight)
    leftGrid.rotation.y = Math.PI / 2
    leftGrid.position.set(-ROOM.width / 2, centerY, 0)
    this.group.add(leftGrid)

    // Right wall grid
    const rightGrid = createGridPlane(ROOM.depth, wallHeight)
    rightGrid.rotation.y = -Math.PI / 2
    rightGrid.position.set(ROOM.width / 2, centerY, 0)
    this.group.add(rightGrid)
  }
}
