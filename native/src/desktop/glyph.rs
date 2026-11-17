// Pure state glyph shared by menu-bar, Windows tray and Linux pixmap adapters.
use super::DesktopState;

pub(super) const SIZE: u32 = 64;

// Four-by-four coverage samples per output pixel retain rounded stroke edges
// when the native host scales this 24-point design to its status-item size.
pub(super) fn rgba(state: &DesktopState) -> Vec<u8> {
    let mut pixels = vec![0; (SIZE * SIZE * 4) as usize];
    for y in 0..SIZE {
        for x in 0..SIZE {
            let mut coverage = 0;
            for sy in 0..4 {
                for sx in 0..4 {
                    let px = (x as f64 + (sx as f64 + 0.5) / 4.0) * 24.0 / SIZE as f64 - 12.0;
                    let py = (y as f64 + (sy as f64 + 0.5) / 4.0) * 24.0 / SIZE as f64 - 12.0;
                    let dot =
                        |cx: f64, radius: f64| (px - cx).powi(2) + py.powi(2) <= radius.powi(2);
                    // Length describes the centerline; radius-one caps add two
                    // points to the complete silhouette, like Lucide's stroke.
                    let bar = |cx: f64, length: f64| {
                        (px - cx).powi(2) + (py.abs() - length / 2.0).max(0.0).powi(2) <= 1.0
                    };
                    let ink = match state {
                        DesktopState::Ready => [2.0, 6.0, 10.0, 14.0, 18.0, 22.0]
                            .into_iter()
                            .any(|x| bar(x - 12.0, 1.0)),
                        DesktopState::Recording => [
                            (2.0, 3.0),
                            (6.0, 11.0),
                            (10.0, 18.0),
                            (14.0, 7.0),
                            (18.0, 13.0),
                            (22.0, 3.0),
                        ]
                        .into_iter()
                        .any(|(x, length)| bar(x - 12.0, length)),
                        DesktopState::Finishing => bar(-4.0, 4.0) || bar(0.0, 4.0) || bar(4.0, 4.0),
                        DesktopState::Starting => dot(-5.0, 1.0) || dot(0.0, 1.65) || dot(5.0, 1.0),
                        DesktopState::Unavailable => {
                            ((px - py).abs() < 0.8 || (px + py).abs() < 0.8)
                                && px.abs() < 4.0
                                && py.abs() < 4.0
                        }
                    };
                    if ink {
                        coverage += 1;
                    }
                }
            }
            let index = ((y * SIZE + x) * 4) as usize;
            pixels[index..index + 4].copy_from_slice(&[110, 139, 177, (coverage * 255 / 16) as u8]);
        }
    }
    pixels
}

// StatusNotifierItem uses network-order ARGB32 rather than tray-icon's RGBA.
#[cfg(any(target_os = "linux", test))]
pub(super) fn argb(state: &DesktopState) -> Vec<u8> {
    let mut pixels = rgba(state);
    for pixel in pixels.chunks_exact_mut(4) {
        pixel.rotate_right(1);
    }
    pixels
}

#[cfg(test)]
mod tests {
    use super::*;
    fn component_bounds(state: &DesktopState) -> Vec<(usize, usize, usize, usize)> {
        let pixels = rgba(state);
        let mut visited = vec![false; 64 * 64];
        let mut components = Vec::new();
        for start in 0..visited.len() {
            if visited[start] || pixels[start * 4 + 3] < 128 {
                continue;
            }
            let mut pending = vec![start];
            let (mut left, mut right, mut top, mut bottom) = (64, 0, 64, 0);
            while let Some(index) = pending.pop() {
                if visited[index] || pixels[index * 4 + 3] < 128 {
                    continue;
                }
                visited[index] = true;
                let (x, y) = (index % 64, index / 64);
                left = left.min(x);
                right = right.max(x);
                top = top.min(y);
                bottom = bottom.max(y);
                if x > 0 {
                    pending.push(index - 1);
                }
                if x < 63 {
                    pending.push(index + 1);
                }
                if y > 0 {
                    pending.push(index - 64);
                }
                if y < 63 {
                    pending.push(index + 64);
                }
            }
            components.push((left, right, top, bottom));
        }
        components.sort_by_key(|component| component.0);
        components
    }
    #[test]
    fn listening_has_six_separate_asymmetric_audio_line_strokes() {
        let bounds = component_bounds(&DesktopState::Recording);
        assert_eq!(
            bounds.len(),
            6,
            "listening must retain the six audio-lines strokes"
        );
        let heights: Vec<_> = bounds
            .iter()
            .map(|(_, _, top, bottom)| bottom - top + 1)
            .collect();
        assert_eq!(heights[0], heights[5], "the short end strokes match");
        assert!(
            heights[2] > heights[4]
                && heights[4] > heights[1]
                && heights[1] > heights[3]
                && heights[3] > heights[0],
            "the six-stroke asymmetric listening silhouette was lost: {heights:?}"
        );
        assert!(
            bounds[0].0 < 6 && bounds[5].1 > 57,
            "strokes span the glyph width"
        );
    }
    #[test]
    fn ready_and_finishing_use_quiet_separate_strokes() {
        let ready = component_bounds(&DesktopState::Ready);
        assert_eq!(ready.len(), 6, "ready is the quiet six-stroke counterpart");
        assert!(ready.iter().all(|(_, _, top, bottom)| bottom - top < 10));
        let finishing = component_bounds(&DesktopState::Finishing);
        assert_eq!(finishing.len(), 3);
        assert!(
            finishing
                .iter()
                .all(|(_, _, top, bottom)| bottom - top == finishing[0].3 - finishing[0].2)
        );
    }
    #[test]
    fn idle_mark_is_quiet_and_listening_uses_the_whole_glyph() {
        let extent = |state| {
            let pixels = rgba(&state);
            let rows: Vec<_> = (0..64)
                .filter(|y| {
                    pixels[y * 64 * 4..(y + 1) * 64 * 4]
                        .chunks_exact(4)
                        .any(|p| p[3] > 0)
                })
                .collect();
            rows.last().unwrap() - rows.first().unwrap()
        };
        assert!(
            extent(DesktopState::Ready) < 12,
            "idle has a quiet horizontal silhouette"
        );
        assert!(
            extent(DesktopState::Recording) > 32,
            "listening changes the glyph, not a small badge"
        );
    }
    #[test]
    fn state_marks_are_distinct_and_antialiased() {
        let ready = rgba(&DesktopState::Ready);
        assert!(
            ready
                .chunks_exact(4)
                .any(|pixel| pixel[3] > 0 && pixel[3] < 255)
        );
        let states = [
            DesktopState::Ready,
            DesktopState::Starting,
            DesktopState::Recording,
            DesktopState::Finishing,
            DesktopState::Unavailable,
        ];
        for (index, state) in states.iter().enumerate() {
            for other in &states[index + 1..] {
                assert_ne!(rgba(state), rgba(other));
            }
        }
    }

    #[test]
    fn linux_pixmaps_keep_alpha_first_and_rgb_in_network_order() {
        let pixels = argb(&DesktopState::Recording);
        assert_eq!(pixels.len(), (SIZE * SIZE * 4) as usize);
        assert!(
            pixels
                .chunks_exact(4)
                .any(|pixel| pixel == [255, 110, 139, 177])
        );
        assert!(
            pixels
                .chunks_exact(4)
                .any(|pixel| pixel[0] > 0 && pixel[0] < 255)
        );
        assert!(
            pixels
                .chunks_exact(4)
                .all(|pixel| pixel[1..] == [110, 139, 177])
        );
    }
}
