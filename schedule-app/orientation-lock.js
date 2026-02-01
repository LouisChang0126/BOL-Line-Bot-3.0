// ===========================
// 螢幕方向鎖定為橫向
// ===========================

(function () {
    'use strict';

    // 嘗試使用 Screen Orientation API 鎖定為橫向
    function lockOrientation() {
        if (screen.orientation && screen.orientation.lock) {
            screen.orientation.lock('landscape').catch(function (error) {
                console.log('無法鎖定螢幕方向:', error);
            });
        }
    }

    // 檢查並顯示/隱藏旋轉提示
    function checkOrientation() {
        const rotateOverlay = document.getElementById('rotate-overlay');
        if (!rotateOverlay) return;

        // 檢查是否為直向模式
        const isPortrait = window.matchMedia('(orientation: portrait)').matches;

        if (isPortrait) {
            rotateOverlay.style.display = 'flex';
        } else {
            rotateOverlay.style.display = 'none';
        }
    }

    // 監聽螢幕方向改變
    function setupOrientationHandling() {
        // 創建旋轉提示覆蓋層
        const overlay = document.createElement('div');
        overlay.id = 'rotate-overlay';
        overlay.innerHTML = `
            <div class="rotate-message">
                <div class="rotate-icon">📱</div>
                <h2>請旋轉您的裝置</h2>
                <p>此網站最佳瀏覽模式為<strong>橫向</strong></p>
                <div class="rotate-arrow">↻</div>
            </div>
        `;
        document.body.appendChild(overlay);

        // 初始檢查
        checkOrientation();

        // 監聽方向改變
        window.addEventListener('orientationchange', checkOrientation);
        window.addEventListener('resize', checkOrientation);

        // 嘗試鎖定方向（需要在全螢幕模式下才有效）
        document.addEventListener('click', lockOrientation, { once: true });
        document.addEventListener('touchstart', lockOrientation, { once: true });
    }

    // 當 DOM 載入完成後執行
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', setupOrientationHandling);
    } else {
        setupOrientationHandling();
    }
})();
