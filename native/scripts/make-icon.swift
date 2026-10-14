#!/usr/bin/env swift
// Generates Louie.iconset (a monkey face) for `iconutil`.
// Usage: swift scripts/make-icon.swift <output-dir>
import AppKit

let outDir = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "Louie.iconset"

func draw(size s: CGFloat) -> NSImage {
    let img = NSImage(size: NSSize(width: s, height: s))
    img.lockFocus()
    func circle(_ x: CGFloat, _ y: CGFloat, _ r: CGFloat, _ color: NSColor) {
        let p = NSBezierPath(ovalIn: NSRect(x: x - r, y: y - r, width: 2 * r, height: 2 * r))
        color.setFill(); p.fill()
    }
    let brown = NSColor(calibratedRed: 0.42, green: 0.28, blue: 0.18, alpha: 1)
    let ear = NSColor(calibratedRed: 0.60, green: 0.42, blue: 0.28, alpha: 1)
    let face = NSColor(calibratedRed: 0.85, green: 0.70, blue: 0.52, alpha: 1)
    let muzzle = NSColor(calibratedRed: 0.94, green: 0.84, blue: 0.68, alpha: 1)

    circle(s * 0.5, s * 0.5, s * 0.46, brown)          // head
    circle(s * 0.14, s * 0.52, s * 0.155, ear)          // ears
    circle(s * 0.86, s * 0.52, s * 0.155, ear)
    circle(s * 0.14, s * 0.52, s * 0.09, brown)
    circle(s * 0.86, s * 0.52, s * 0.09, brown)

    let f = NSBezierPath(ovalIn: NSRect(x: s * 0.22, y: s * 0.16, width: s * 0.56, height: s * 0.64))
    face.setFill(); f.fill()

    circle(s * 0.40, s * 0.585, s * 0.062, .black)      // eyes
    circle(s * 0.60, s * 0.585, s * 0.062, .black)
    circle(s * 0.415, s * 0.60, s * 0.020, .white)
    circle(s * 0.615, s * 0.60, s * 0.020, .white)

    circle(s * 0.435, s * 0.38, s * 0.105, muzzle)      // muzzle
    circle(s * 0.565, s * 0.38, s * 0.105, muzzle)
    circle(s * 0.468, s * 0.405, s * 0.016, .black)     // nostrils
    circle(s * 0.532, s * 0.405, s * 0.016, .black)

    let mouth = NSBezierPath()
    mouth.move(to: NSPoint(x: s * 0.43, y: s * 0.315))
    mouth.curve(to: NSPoint(x: s * 0.57, y: s * 0.315),
                controlPoint1: NSPoint(x: s * 0.47, y: s * 0.235),
                controlPoint2: NSPoint(x: s * 0.53, y: s * 0.235))
    NSColor.black.setStroke(); mouth.lineWidth = max(1, s * 0.014); mouth.stroke()

    img.unlockFocus()
    return img
}

func writePNG(_ image: NSImage, pixels: Int, to path: String) {
    guard let tiff = image.tiffRepresentation,
          let rep = NSBitmapImageRep(data: tiff) else { return }
    rep.size = NSSize(width: pixels, height: pixels)
    guard let data = rep.representation(using: .png, properties: [:]) else { return }
    try? data.write(to: URL(fileURLWithPath: path))
}

try? FileManager.default.createDirectory(atPath: outDir, withIntermediateDirectories: true)
let entries: [(name: String, px: Int)] = [
    ("icon_16x16.png", 16), ("icon_16x16@2x.png", 32),
    ("icon_32x32.png", 32), ("icon_32x32@2x.png", 64),
    ("icon_128x128.png", 128), ("icon_128x128@2x.png", 256),
    ("icon_256x256.png", 256), ("icon_256x256@2x.png", 512),
    ("icon_512x512.png", 512), ("icon_512x512@2x.png", 1024),
]
for e in entries {
    writePNG(draw(size: CGFloat(e.px)), pixels: e.px, to: "\(outDir)/\(e.name)")
}
print("wrote \(entries.count) icons to \(outDir)")
