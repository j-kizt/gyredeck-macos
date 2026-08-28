import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

let CX = 512.0, CY = 512.0, R = 245.0
let START = -15.0 * .pi / 180.0   // gap sits at the upper right
let END = 285.0 * .pi / 180.0     // 300 degree sweep

// Pin context and colors to the same sRGB space; mixing DeviceRGB with the
// default CGColor space silently shifts every hex value.
let SRGB = CGColorSpace(name: CGColorSpace.sRGB)!

func context(_ size: Int) -> CGContext {
    let ctx = CGContext(
        data: nil, width: size, height: size, bitsPerComponent: 8, bytesPerRow: 0,
        space: SRGB,
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    ctx.interpolationQuality = .high
    ctx.setAllowsAntialiasing(true)
    // Flip to SVG's y-down space so the design numbers transfer verbatim.
    ctx.translateBy(x: 0, y: CGFloat(size))
    ctx.scaleBy(x: 1, y: -1)
    let s = CGFloat(size) / 1024.0
    ctx.scaleBy(x: s, y: s)
    return ctx
}

func arcPath(radius: Double, width: Double) -> CGPath {
    let p = CGMutablePath()
    p.addArc(center: CGPoint(x: CX, y: CY), radius: CGFloat(radius),
             startAngle: CGFloat(START), endAngle: CGFloat(END), clockwise: false)
    return p.copy(strokingWithWidth: CGFloat(width), lineCap: .round, lineJoin: .round, miterLimit: 10)
}

func write(_ ctx: CGContext, _ path: String) {
    let url = URL(fileURLWithPath: path)
    let dest = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil)!
    CGImageDestinationAddImage(dest, ctx.makeImage()!, nil)
    guard CGImageDestinationFinalize(dest) else { fatalError("write failed: \(path)") }
    print("wrote \(path)")
}

func rgb(_ hex: UInt32) -> CGColor {
    CGColor(colorSpace: SRGB, components: [
        CGFloat((hex >> 16) & 0xff) / 255, CGFloat((hex >> 8) & 0xff) / 255,
        CGFloat(hex & 0xff) / 255, 1])!
}

// ---- app icon: rounded plate, gradient gyre, still core ----
let app = context(1024)
app.addPath(CGPath(roundedRect: CGRect(x: 0, y: 0, width: 1024, height: 1024),
                   cornerWidth: 224, cornerHeight: 224, transform: nil))
app.setFillColor(rgb(0x0E1726))
app.fillPath()

app.saveGState()
app.addPath(arcPath(radius: R, width: 92))
app.clip()
let grad = CGGradient(colorsSpace: SRGB,
                      colors: [rgb(0x2B5FA8), rgb(0x4BA3C7)] as CFArray, locations: [0, 1])!
app.drawLinearGradient(grad, start: CGPoint(x: 221, y: 221), end: CGPoint(x: 803, y: 803),
                       options: [.drawsBeforeStartLocation, .drawsAfterEndLocation])
app.restoreGState()

app.setFillColor(rgb(0x7EC8E3))
app.addEllipse(in: CGRect(x: CX - 86, y: CY - 86, width: 172, height: 172))
app.fillPath()
write(app, CommandLine.arguments[1])

// ---- tray icon: same mark, no plate, white so macOS can tint it ----
// The app icon's radius leaves margin for the rounded plate. The tray has no
// plate, so the mark is scaled up (same proportions) to fill ~98% of the frame
// — otherwise it renders visibly smaller than the neighbouring status items.
let TRAY_R = 409.0                    // R * 1.669
let TRAY_STROKE = 187.0               // 112 * 1.669
let TRAY_CORE = 173.0                 // 104 * 1.669
let tray = context(128)
tray.setFillColor(rgb(0xFFFFFF))
tray.addPath(arcPath(radius: TRAY_R, width: TRAY_STROKE))
tray.fillPath()
tray.addEllipse(in: CGRect(x: CX - TRAY_CORE, y: CY - TRAY_CORE,
                           width: TRAY_CORE * 2, height: TRAY_CORE * 2))
tray.fillPath()
write(tray, CommandLine.arguments[2])
