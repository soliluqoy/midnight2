# Synthetic speech fixtures

These contain only the English phrases “Make this paragraph clearer.” and “Do not change the numbers.” spoken by Windows `System.Speech.Synthesis.SpeechSynthesizer`, with `SpeechAudioFormatInfo(16000, Sixteen, Mono)` and `SetOutputToWaveFile`.

They were generated locally on 13 October 2026. They contain no recorded microphone audio. The fixture digest includes their exact bytes, so regenerating them invalidates prior qualification records. The fixture set also creates silence, three red bars and ordered red/blue/green images in memory. Passing this small set establishes that the selected account/model/transport can interpret these synthetic inputs; it does not establish multilingual speech accuracy, video understanding, continuous capture or performance during work.
