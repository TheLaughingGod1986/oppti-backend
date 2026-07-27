<?php
/**
 * OpptiAI Alt Text — in-plugin review prompt.
 *
 * Asks happy users for a WordPress.org review at their moment of success,
 * without nagging. Drop this file into the plugin and require it from the main
 * plugin file:
 *
 *     require_once __DIR__ . '/opptiai-review-prompt.php';
 *
 * Then, wherever a generation SUCCEEDS (e.g. after a completed bulk run),
 * record it once:
 *
 *     OpptiAI_Review_Prompt::record_success( $images_generated );
 *
 * That's the only integration point. The class handles when/whether to show the
 * notice, the "remind me later" and "don't ask again" logic, and the links.
 *
 * Behaviour:
 *   - Never shown until the user has had a real success (>= REQUIRED_IMAGES
 *     images generated), so brand-new/unsuccessful users are never asked.
 *   - Shown only on the plugin's own admin screens.
 *   - "Maybe later" snoozes for 2 weeks; "Already did / No thanks" hides forever.
 *   - Auto-hides forever once the user clicks through to leave a review.
 */

if ( ! defined( 'ABSPATH' ) ) { exit; }

class OpptiAI_Review_Prompt {

	const OPTION        = 'opptiai_review_state';
	const REQUIRED_IMAGES = 10;   // must have generated at least this many
	const SNOOZE_DAYS   = 14;     // "maybe later" delay
	const REVIEW_URL    = 'https://wordpress.org/support/plugin/beepbeep-ai-alt-text-generator/reviews/#new-post';
	// Substring that identifies this plugin's own admin pages (adjust if needed):
	const PAGE_HINT     = 'beepbeep'; // matches ?page=beepbeep... / ?page=bbai...

	public static function init() {
		add_action( 'admin_init', array( __CLASS__, 'handle_action' ) );
		add_action( 'admin_notices', array( __CLASS__, 'maybe_render' ) );
	}

	private static function state() {
		return wp_parse_args( (array) get_option( self::OPTION, array() ), array(
			'images'    => 0,
			'status'    => 'pending', // pending | snoozed | done
			'remind_at' => 0,
			'first_success' => 0,
		) );
	}

	/** Call this once per successful generation. */
	public static function record_success( $images = 1 ) {
		$s = self::state();
		if ( $s['status'] === 'done' ) { return; }
		$s['images'] += max( 1, (int) $images );
		if ( ! $s['first_success'] ) { $s['first_success'] = time(); }
		update_option( self::OPTION, $s, false );
	}

	private static function on_plugin_page() {
		return isset( $_GET['page'] ) && strpos( (string) $_GET['page'], self::PAGE_HINT ) !== false;
	}

	private static function should_show() {
		if ( ! current_user_can( 'manage_options' ) || ! self::on_plugin_page() ) { return false; }
		$s = self::state();
		if ( $s['status'] === 'done' ) { return false; }
		if ( $s['status'] === 'snoozed' && time() < (int) $s['remind_at'] ) { return false; }
		return (int) $s['images'] >= self::REQUIRED_IMAGES;
	}

	public static function maybe_render() {
		if ( ! self::should_show() ) { return; }
		$s   = self::state();
		$base = admin_url( add_query_arg( null, null ) ); // current admin URL
		$link = function ( $do ) use ( $base ) {
			return wp_nonce_url( add_query_arg( 'opptiai_review', $do, $base ), 'opptiai_review' );
		};
		?>
		<div class="notice notice-info is-dismissible" style="border-left-color:#7c3aed;">
			<p style="font-size:14px;margin:.6em 0;">
				<strong>Nice — you've generated <?php echo (int) $s['images']; ?> alt-text descriptions with OpptiAI.</strong><br>
				If it's saved you time, a quick review helps other site owners find it. It genuinely makes a difference for an independent plugin.
			</p>
			<p style="margin:.6em 0 1em;">
				<a href="<?php echo esc_url( self::REVIEW_URL ); ?>" class="button button-primary"
				   target="_blank" rel="noopener"
				   onclick="window.location='<?php echo esc_js( $link( 'done' ) ); ?>';">Leave a review</a>
				<a href="<?php echo esc_url( $link( 'later' ) ); ?>" class="button" style="margin-left:6px;">Maybe later</a>
				<a href="<?php echo esc_url( $link( 'never' ) ); ?>" style="margin-left:12px;color:#666;">Already did / no thanks</a>
			</p>
		</div>
		<?php
	}

	public static function handle_action() {
		if ( empty( $_GET['opptiai_review'] ) ) { return; }
		if ( ! current_user_can( 'manage_options' )
			|| ! wp_verify_nonce( $_GET['_wpnonce'] ?? '', 'opptiai_review' ) ) { return; }
		$s  = self::state();
		$do = sanitize_key( $_GET['opptiai_review'] );
		if ( $do === 'later' ) {
			$s['status']    = 'snoozed';
			$s['remind_at'] = time() + self::SNOOZE_DAYS * DAY_IN_SECONDS;
		} elseif ( $do === 'never' || $do === 'done' ) {
			$s['status'] = 'done';
		}
		update_option( self::OPTION, $s, false );
		wp_safe_redirect( remove_query_arg( array( 'opptiai_review', '_wpnonce' ) ) );
		exit;
	}
}

OpptiAI_Review_Prompt::init();
