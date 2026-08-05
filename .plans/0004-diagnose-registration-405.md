# Diagnostic du refus d'enregistrement 405

## Incident

Une tentative d'appairage par code ouvre la WebSocket puis échoue avant
l'émission d'un événement `qr`, avec le statut Baileys `405`.

## Instrumentation

Le niveau du logger Baileys est configurable via `logging.baileys_level`.
Pour ce diagnostic local, `trace` est utilisé avec
`logging.baileys_log_message_text: true`, afin de conserver la trame de refus
complète. Cette configuration est réservée au volume de test.

## Résultat observé

La séquence est :

1. handshake WebSocket/Noise réussi ;
2. client non authentifié, tentative d'enregistrement ;
3. réponse serveur `<failure reason='405' location='frc'/>` ;
4. aucun code d'appairage ni état d'authentification conservé.

Le tuple de version configuré est présent dans le payload d'enregistrement.
Le refus intervient donc après le handshake, sur le contrôle d'inscription du
nouvel appareil. L'hypothèse prioritaire à tester est une politique ou une
réputation de l'IP de sortie d'hébergement, sans exclure une règle liée au
compte ou à l'identité de l'appareil.

## Critères de suite

- comparer avec une tentative depuis une IP résidentielle ou mobile ;
- conserver le même code et le même compte pour isoler la variable réseau ;
- ne pas multiplier les tentatives rapprochées afin d'éviter une limitation ;
- remettre ensuite le logger Baileys au niveau par défaut.
