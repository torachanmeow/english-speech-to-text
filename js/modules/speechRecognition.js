/**
 * 音声認識モジュール
 * English Speech to Text
 * 
 * Web Speech APIを使用して英語音声をリアルタイムでテキスト化するモジュール
 * 自動再起動、エラー処理機能を含む
 * 
 * 機能概要:
 * - Web Speech APIを使用した英語音声認識
 * - セッション管理による安定した認識処理
 * - Watchdog機能による自動再起動
 * - エラーハンドリングと自動復旧
 * - リアルタイム結果処理
 * - 英語音声認識対応
 */

// 音声認識設定定数
const RECOGNITION_CONSTANTS = {
    MAX_SESSION_TIMEOUT: 30000,        // セッションタイムアウト（30秒）
    RESTART_COOLDOWN: 500,             // 再起動時の待機時間（ミリ秒）
    ERROR_THRESHOLD: 5,                // エラー回数の閾値
    RESULT_BUFFER_SIZE: 100            // 結果バッファサイズ
};

class SpeechRecognitionManager {
    constructor() {
        // Web Speech API認識インスタンス
        this.recognition = null;
        
        // 認識状態管理
        this.isRecognizing = false;       // 現在認識中かどうか
        this.sessionId = null;            // 現在のセッションID
        
        // Watchdog機能（認識停止検知・自動再起動）
        this.watchdogTimer = null;        // Watchdogタイマー
        this.lastResultTime = 0;          // 最後に結果を受信した時刻
        this.sessionStartTime = 0;        // セッション開始時刻
        
        // エラー管理
        this.errorCount = 0;              // 連続エラー回数
        
        
        // 重複防止
        this.processedTexts = new Set();  // 処理済みテキストの追跡
        
        // 手動停止フラグ
        this.manualStop = false;          // 手動停止時の自動再開防止
        
        // 設定の読み込み
        this.config = APP_CONFIG.SPEECH_CONFIG;
        
        // 初期化実行
        this.initializeRecognition();
    }

    /**
     * 音声認識の初期化
     * Web Speech APIの利用可能性を確認し、認識インスタンスを作成
     * ブラウザ対応チェックと基本設定を実行
     * 
     * @returns {boolean} 初期化成功可否
     */
    initializeRecognition() {
        try {
            // ブラウザ対応確認
            const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
            
            if (!SpeechRecognition) {
                stateManager.setError('SPEECH_RECOGNITION', 'NOT_SUPPORTED');
                return false;
            }

            this.recognition = new SpeechRecognition();
            this.setupRecognitionConfig();
            this.setupEventHandlers();
            
            return true;
            
        } catch (error) {
            stateManager.setError('SPEECH_RECOGNITION', 'NOT_SUPPORTED', error.message);
            return false;
        }
    }

    /**
     * 音声認識の基本設定
     * 連続認識、中間結果、最大候補数、言語などを設定
     * stateManagerから現在の言語設定を取得して適用
     */
    setupRecognitionConfig() {
        if (!this.recognition) return;

        this.recognition.continuous = this.config.continuous;
        this.recognition.interimResults = this.config.interimResults;
        this.recognition.maxAlternatives = this.config.maxAlternatives;
        
        // 言語設定
        const language = stateManager.getState('config.language') || 'en-US';
        this.recognition.lang = language;
    }

    /**
     * Web Speech APIイベントハンドラー設定
     * 認識開始・終了・結果受信・エラーなどの各イベントを処理
     * セッション管理とWatchdog機能を統合
     */
    setupEventHandlers() {
        if (!this.recognition) return;

        // 音声認識開始イベント
        // セッションIDを生成し、状態管理とWatchdogを開始
        this.recognition.onstart = () => {
            this.isRecognizing = true;
            this.sessionId = Utils.generateId('session');
            this.lastResultTime = Date.now();
            this.sessionStartTime = Date.now();
            this.errorCount = 0;
            
            stateManager.updateRecognitionState({
                isActive: true,
                isListening: true,
                sessionId: this.sessionId,
                recognitionInstance: this.recognition
            });
            
            this.startWatchdog();
        };

        // 音声認識終了イベント
        this.recognition.onend = () => {
            this.isRecognizing = false;

            // Watchdogを停止
            this.stopWatchdog();

            // 手動停止でない場合は即座に再開
            if (!this.manualStop) {
                // 状態は維持したまま再開（テキストをクリアしない）
                stateManager.updateRecognitionState({
                    isActive: true,
                    isListening: false
                });

                setTimeout(() => {
                    // 重複開始を防ぐため状態チェック
                    if (!this.isRecognizing) {
                        this.start();
                    }
                }, this.config.restartDelay);
            } else {
                // 手動停止の場合のみ完全リセット
                this.resetInternalState();
                this.resetStateManagerState(true);
                $(document).trigger('clearInterimText');
            }

            // フラグをリセット
            this.manualStop = false;
        };

        // 音声認識結果受信イベント
        // 中間結果と最終結果を処理
        this.recognition.onresult = (event) => {
            this.handleResult(event);
        };

        // エラーハンドリング
        // エラーコードに応じた処理と自動再起動判定
        this.recognition.onerror = (event) => {
            this.handleError(event);
        };

        // 音声検出なしイベント
        // 音声は検出されたが認識可能なテキストが見つからない場合
        this.recognition.onnomatch = () => {
            // 現在は特別な処理なし（ログ出力のみ）
        };

        // 音声入力開始イベント
        // マイクロフォンから音声の検出開始
        this.recognition.onsoundstart = () => {
            // 現在は特別な処理なし（将来的にUI状態更新など）
        };

        // 音声入力終了イベント
        // マイクロフォンからの音声検出終了
        this.recognition.onsoundend = () => {
            // 現在は特別な処理なし（将来的にUI状態更新など）
        };

        // 発話開始イベント
        // 認識可能な音声の開始検出
        this.recognition.onspeechstart = () => {
            // 現在は特別な処理なし（将来的にリアルタイム状態表示など）
        };

        // 発話終了イベント
        // 認識可能な音声の終了検出
        this.recognition.onspeechend = () => {
            // 現在は特別な処理なし（将来的にリアルタイム状態表示など）
        };
    }

    /**
     * 音声認識結果処理
     * Web Speech APIから受信した認識結果を処理
     * 中間結果（リアルタイム）と最終結果を分離して処理
     * セッション管理により古いセッションからの結果を無視
     * 
     * @param {SpeechRecognitionEvent} event - 音声認識結果イベント
     */
    handleResult(event) {
        try {
            const currentSessionId = this.sessionId;
            this.lastResultTime = Date.now();
            
            let interimTranscript = '';
            let finalTranscript = '';
            
            // 結果を処理
            for (let i = event.resultIndex; i < event.results.length; i++) {
                const result = event.results[i];
                const transcript = result[0].transcript;
                
                if (result.isFinal) {
                    finalTranscript += transcript;
                } else {
                    interimTranscript += transcript;
                }
            }
            
            // セッション確認（Watchdog対策）
            if (currentSessionId !== this.sessionId) {
                return;
            }
            
            // 状態更新
            if (interimTranscript) {
                stateManager.updateRecognitionState({
                    interimText: interimTranscript,
                    currentText: finalTranscript + interimTranscript
                });
                
                // UIに中間結果を通知
                $(document).trigger('interimTextRecognized', {
                    text: interimTranscript
                });
            }
            
            if (finalTranscript) {
                this.processFinalResult(finalTranscript);
            }
            
        } catch (error) {
        }
    }

    /**
     * 最終認識結果の処理
     * 確定したテキストをクリーニングして処理
     * テキスト履歴への追加とUI更新イベントを発火
     * 
     * @param {string} text - 認識された最終テキスト
     * @returns {Promise<void>}
     */
    async processFinalResult(text) {
        try {
            let trimmedText = Utils.trimText(text);
            if (!trimmedText) return;
            
            // 重複処理チェック：同じテキストを短時間で複数回処理しない
            if (this.processedTexts.has(trimmedText)) {
                return;
            }
            
            // 処理済みテキストに追加（設定時間後に自動削除）
            this.processedTexts.add(trimmedText);
            setTimeout(() => {
                this.processedTexts.delete(trimmedText);
            }, this.config.duplicateCheckTimeout);
            
            // テキスト履歴に追加
            stateManager.addTextHistory({
                originalText: trimmedText,
                language: stateManager.getState('config.language')
            });
            
            // 状態更新
            stateManager.updateRecognitionState({
                finalText: trimmedText,
                currentText: trimmedText
            });
            
            // UIに表示を通知
            $(document).trigger('textRecognized', {
                text: trimmedText
            });
            
        } catch (error) {
        }
    }

    /**
     * 音声認識エラーハンドリング
     * エラーコードに応じた適切な処理と自動復旧機能
     * 連続エラー回数を管理し、閾値超過時は認識を停止
     * 特定エラーに対しては自動再起動を実行
     * 
     * @param {SpeechRecognitionErrorEvent} event - エラーイベント
     */
    handleError(event) {
        this.errorCount++;
        const errorCode = this.mapErrorCode(event.error);


        // エラー回数を更新（UIには反映するが、認識は止めない）
        stateManager.updateRecognitionState({
            errorCount: this.errorCount
        });

        // 重大なエラーの場合のみ停止
        const criticalErrors = ['not-allowed', 'service-not-allowed'];
        if (criticalErrors.includes(event.error)) {
            stateManager.setError('SPEECH_RECOGNITION', errorCode, event.error);
            this.stop();
            return;
        }

        // 一定回数以上エラーが発生した場合は停止
        if (this.errorCount >= this.config.maxErrorCount) {
            this.stop();
            return;
        }

        // 通常のエラーは無視して認識を継続
        // 音声認識が自然に終了した場合、onendイベントで自動再開される
    }

    /**
     * Web Speech APIエラーコードをアプリケーション内部コードにマッピング
     * ブラウザ固有のエラーコードを統一的な形式に変換
     * 
     * @param {string} error - Web Speech APIエラーコード
     * @returns {string} 内部エラーコード
     */
    mapErrorCode(error) {
        const errorMap = {
            'not-allowed': 'NOT_ALLOWED',
            'no-speech': 'NO_SPEECH',
            'aborted': 'ABORTED',
            'audio-capture': 'AUDIO_CAPTURE',
            'network': 'NETWORK',
            'timeout': 'TIMEOUT'
        };
        
        return errorMap[error] || 'UNKNOWN';
    }

    /**
     * エラー種別による自動再起動可否判定
     * 一時的なエラー（音声なし、中断、音声キャプチャ）は再起動対象
     * 権限エラーやネットワークエラーは再起動しない
     * 
     * @param {string} error - エラーコード
     * @returns {boolean} 再起動可否
     */
    shouldAutoRestart(error) {
        const restartableErrors = ['no-speech', 'aborted', 'audio-capture', 'timeout'];
        // エラーコードが未定義の場合も再起動対象とする
        return !error || restartableErrors.includes(error);
    }

    /**
     * Watchdog機能の開始
     * 定期的に最後の結果受信時刻と絶対時間をチェックし、タイムアウト時に自動再起動
     * 音声認識が無応答状態になった場合の復旧機能
     * タイマー間隔とタイムアウト時間は設定ファイルで制御
     */
    startWatchdog() {
        this.stopWatchdog(); // 既存のタイマークリア
        
        this.watchdogTimer = setInterval(() => {
            if (!this.isRecognizing) return;
            
            const now = Date.now();
            const timeSinceLastResult = now - this.lastResultTime;
            const timeSinceSessionStart = now - this.sessionStartTime;
            
            // 2つの条件でタイムアウト判定し、自動再開
            const isResultTimeout = timeSinceLastResult > this.config.deadTime;
            const isSessionTimeout = timeSinceSessionStart > this.config.maxSessionTime;
            
            if (isResultTimeout || isSessionTimeout) {
                this.safeRestart();
            }
        }, this.config.watchdogInterval);
    }

    /**
     * Watchdogタイマーの停止とクリア
     * 音声認識終了時や手動停止時に呼び出される
     */
    stopWatchdog() {
        if (this.watchdogTimer) {
            clearInterval(this.watchdogTimer);
            this.watchdogTimer = null;
        }
    }

    /**
     * 認識インスタンスの強制停止処理
     * @private
     */
    forceStopRecognition() {
        try {
            if (this.recognition) {
                this.recognition.stop();
            }
        } catch (e) {
            // 停止エラーは無視（既に停止している可能性）
        }
    }

    /**
     * 内部状態の完全リセット処理
     * @private
     */
    resetInternalState() {
        this.isRecognizing = false;
        this.stopWatchdog();
    }

    /**
     * 状態管理システムの状態リセット処理
     * @private
     * @param {boolean} clearTexts - テキスト関連の状態もクリアするかどうか
     */
    resetStateManagerState(clearTexts = false) {
        const stateUpdate = {
            isActive: false,
            isListening: false
        };
        
        if (clearTexts) {
            stateUpdate.currentText = '';
            stateUpdate.interimText = '';
        }
        
        stateManager.updateRecognitionState(stateUpdate);
    }

    /**
     * 中間結果を確実にクリアする共通処理
     * 複数のタイミングで削除イベントを発火して取りこぼしを防止
     * @private
     */
    clearInterimTextReliably() {
        // 即座にクリア
        $(document).trigger('clearInterimText');
        
        // DOM更新タイミングを考慮した段階的クリア
        const clearDelays = [10, 50];
        clearDelays.forEach(delay => {
            setTimeout(() => $(document).trigger('clearInterimText'), delay);
        });
    }

    /**
     * 音声認識の完全リセット処理
     * 内部状態、音声認識インスタンス、状態管理、中間結果を一括でリセット
     * @private
     * @param {boolean} clearTexts - テキスト関連の状態もクリアするかどうか
     */
    performFullReset(clearTexts = false) {
        this.resetInternalState();
        this.forceStopRecognition();
        this.resetStateManagerState(clearTexts);
        this.clearInterimTextReliably();
    }

    /**
     * 音声認識の開始
     * 重複起動チェック、言語設定の更新、認識インスタンスの開始
     * エラー時は適切なエラー状態を設定
     * 
     * @returns {boolean} 開始成功可否
     */
    start() {
        try {
            if (!this.recognition) {
                // 認識インスタンスが存在しない場合は再初期化を試行
                if (!this.initializeRecognition()) {
                    stateManager.setError('SPEECH_RECOGNITION', 'NOT_SUPPORTED');
                    return false;
                }
            }
            
            // 既に認識中の場合は重複起動を防ぐ
            if (this.isRecognizing) {
                return true;
            }
            
            // 認識インスタンスが既に動作中の場合は強制停止
            this.forceStopRecognition();
            
            // 状態を確実にリセット
            this.resetInternalState();
            
            // 前の認識が完全に終了するまで待機
            setTimeout(() => {
                try {
                    // 既に開始済みの場合はスキップ
                    if (this.isRecognizing) {
                        return;
                    }

                    // 言語設定を更新
                    const language = stateManager.getState('config.language') || 'en-US';
                    this.recognition.lang = language;

                    this.recognition.start();
                } catch (error) {
                    // 既開始エラーは無視、その他のエラーのみ報告
                    if (!error.message.includes('already started')) {
                        this.resetInternalState();
                        stateManager.setError('SPEECH_RECOGNITION', 'ABORTED', error.message);
                    }
                }
            }, this.config.restartDelay);
            
            return true;
            
        } catch (error) {
            // エラー時は状態をリセット
            this.resetInternalState();
            stateManager.setError('SPEECH_RECOGNITION', 'ABORTED', error.message);
            return false;
        }
    }

    /**
     * 音声認識の停止
     * 認識インスタンスの停止とWatchdogタイマーのクリア
     * 既に停止している場合は安全に処理をスキップ
     * 
     * @returns {boolean} 停止成功可否
     */
    stop() {
        try {
            if (!this.recognition) {
                return true;
            }
            
            // 手動停止フラグを設定
            this.manualStop = true;
            
            // 状態をリセット
            this.performFullReset(true);
            
            // 手動停止時の追加保険（遅延クリア）
            const stopDelays = [100, 200];
            stopDelays.forEach(delay => {
                setTimeout(() => $(document).trigger('clearInterimText'), delay);
            });
            
            return true;
            
        } catch (error) {
            // エラーが発生しても状態はクリア
            this.performFullReset(true);
            this.clearInterimTextReliably();
            return false;
        }
    }

    /**
     * 安全な音声認識再起動機能
     * 現在の状態を保存してから一旦停止し、設定遅延後に再開
     * 言語設定の引き継ぎと状態復旧を保証
     * Watchdogタイムアウトや一時的エラーからの復旧に使用
     */
    safeRestart() {
        try {
            
            const currentLanguage = stateManager.getState('config.language');
            
            // 強制的に状態をクリア
            this.performFullReset(true);
            
            // エラー状態をクリア（エラーカウントをリセット）
            this.errorCount = 0;
            stateManager.updateRecognitionState({
                errorCount: 0
            });
            
            // 少し待ってから再初期化と再開
            setTimeout(() => {
                // 認識インスタンスを再初期化
                this.initializeRecognition();
                
                // 言語設定を更新
                if (this.recognition) {
                    this.recognition.lang = currentLanguage;
                }
                
                // 再開
                this.start();
            }, this.config.restartDelay);
            
        } catch (error) {
        }
    }

    /**
     * 音声認識言語の変更
     * 認識中の場合は一旦停止してから言語を変更し、再開
     * 英語（en-US）と英語（en-GB）の切り替えに対応
     * 
     * @param {string} language - 新しい言語コード（en-US, en-GB）
     * @returns {boolean} 言語変更成功可否
     */
    changeLanguage(language) {
        try {
            
            const wasRecognizing = this.isRecognizing;
            
            // 認識中の場合は一旦停止
            if (wasRecognizing) {
                this.stop();
            }
            
            // 言語設定更新
            if (this.recognition) {
                this.recognition.lang = language;
            }
            
            // 必要に応じて再開
            if (wasRecognizing) {
                setTimeout(() => {
                    this.start();
                }, this.config.restartDelay);
            }
            
            return true;
            
        } catch (error) {
            return false;
        }
    }


    /**
     * 音声認識マネージャーの現在状態を取得
     * デバッグ、状態監視、UI更新などで使用
     * 
     * @returns {Object} 現在の状態情報
     * @returns {boolean} returns.isRecognizing - 認識中フラグ
     * @returns {string|null} returns.sessionId - 現在のセッションID
     * @returns {number} returns.errorCount - 連続エラー回数
     * @returns {string} returns.language - 現在の認識言語
     * @returns {number} returns.lastResultTime - 最後の結果受信時刻
     * @returns {boolean} returns.hasWatchdog - Watchdog動作中フラグ
     */
    getStatus() {
        return {
            isRecognizing: this.isRecognizing,
            sessionId: this.sessionId,
            errorCount: this.errorCount,
            language: this.recognition?.lang,
            lastResultTime: this.lastResultTime,
            hasWatchdog: !!this.watchdogTimer
        };
    }

    /**
     * 音声認識設定の動的更新
     * 設定変更時に再初期化せずに一部設定を変更
     * 
     * @param {Object} newConfig - 新しい設定オブジェクト
     */
    updateConfig(newConfig) {
        this.config = { ...this.config, ...newConfig };
    }

    /**
     * リソースの完全解放とクリーンアップ
     * アプリケーション終了時やインスタンス破棄時に呼び出し
     * メモリリーク防止のため全イベントハンドラーを削除
     */
    destroy() {
        try {
            this.stop();
            
            if (this.recognition) {
                this.recognition.onstart = null;
                this.recognition.onend = null;
                this.recognition.onresult = null;
                this.recognition.onerror = null;
                this.recognition.onnomatch = null;
                this.recognition.onsoundstart = null;
                this.recognition.onsoundend = null;
                this.recognition.onspeechstart = null;
                this.recognition.onspeechend = null;
                this.recognition = null;
            }
            
        } catch (error) {
        }
    }

}

// グローバルインスタンス
try {
    window.speechRecognitionManager = new SpeechRecognitionManager();
} catch (error) {
}