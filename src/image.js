// 업로드한 문제 그림을 적당한 크기의 JPEG로 줄입니다.
const MAX_LONG_SIDE = 2400;
const MAX_SHORT_SIDE = 1200;
const MAX_DATA_URL_LENGTH = 3.5 * 1024 * 1024;

export function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => resolve({ img, url });
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('이미지를 불러올 수 없어요.'));
    };
    img.src = url;
  });
}

export function compressImage(img) {
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  const scale = Math.min(1, MAX_LONG_SIDE / Math.max(w, h), MAX_SHORT_SIDE / Math.min(w, h));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  // Vercel 요청 한도(4.5MB) 안에 들어가도록, 너무 크면 화질을 조금씩 낮춥니다.
  let dataUrl;
  for (const quality of [0.9, 0.8, 0.7, 0.6, 0.5]) {
    dataUrl = canvas.toDataURL('image/jpeg', quality);
    if (dataUrl.length <= MAX_DATA_URL_LENGTH) break;
  }
  return dataUrl;
}
