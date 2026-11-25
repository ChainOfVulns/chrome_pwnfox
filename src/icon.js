/* MV3-compatible icon renderer using OffscreenCanvas (works in Service Worker and DOM pages) */

function drawFoxIntoContext(ctx, size, dotColor) {
    const scale = size / 128;

    ctx.save();
    ctx.scale(scale, scale);

    const drawFoxPath = () => {
        ctx.beginPath();
        ctx.moveTo(20, 40);
        ctx.lineTo(20, 0);
        ctx.lineTo(45, 25);
        ctx.lineTo(83, 25);
        ctx.lineTo(108, 0);
        ctx.lineTo(108, 40);
        ctx.lineTo(128, 40);
        ctx.lineTo(113, 55);
        ctx.lineTo(128, 55);
        ctx.lineTo(64, 118);
        ctx.lineTo(0, 55);
        ctx.lineTo(15, 55);
        ctx.lineTo(0, 40);
        ctx.closePath();
    };

    ctx.save();
    drawFoxPath();
    ctx.clip();

    drawFoxPath();
    ctx.fillStyle = "#ff6633";
    ctx.fill();
    ctx.lineWidth = 10;
    ctx.strokeStyle = "#000000";
    ctx.stroke();

    ctx.fillStyle = "#000000";
    ctx.beginPath();
    ctx.ellipse(48, 62, 8, 7, 0, 0, 2 * Math.PI);
    ctx.fill();

    ctx.beginPath();
    ctx.ellipse(80, 62, 8, 7, 0, 0, 2 * Math.PI);
    ctx.fill();

    ctx.beginPath();
    ctx.arc(64, 110, 12, 0, 2 * Math.PI);
    ctx.fill();

    ctx.restore();
    ctx.restore();

    if (dotColor !== null) {
        ctx.save();
        ctx.scale(size / 48, size / 48);
        ctx.beginPath();
        ctx.arc(8, 40, 7, 0, 2 * Math.PI, false);
        ctx.fillStyle = dotColor;
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = "#000000";
        ctx.stroke();

        /* fox don't cry */
        if (dotColor === "#ff0000") {
            ctx.beginPath();
            ctx.ellipse(33, 28, 0.4, 1.2, 0, 0, 2 * Math.PI);
            ctx.lineWidth = 2;
            ctx.strokeStyle = "#ffffff";
            ctx.stroke();
        }
        ctx.restore();
    }
}

function createIconImageData(dotColor, size = 48) {
    const canvas = new OffscreenCanvas(size, size);
    const ctx = canvas.getContext("2d");
    drawFoxIntoContext(ctx, size, dotColor);
    return ctx.getImageData(0, 0, size, size);
}

function createIconCanvasElement(dotColor, size = 48) {
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    drawFoxIntoContext(ctx, size, dotColor);
    return canvas;
}
