// ============================================================
//  Bâtisseur — Examen de programmation (QCM)
//  Questions à choix unique. Le serveur envoie les questions SANS
//  les réponses ; la notation et les explications se font côté serveur.
//  answer = index de la bonne option (0-based).
// ============================================================

const QUIZ_PROGRAMMATION = {
  id: "programmation",
  title: "Examen de programmation",
  intro: "Un questionnaire pour valider vos bases avant l'attestation. Prenez votre temps : chaque question a une seule bonne réponse.",
  passRatio: 0.7,          // 70 % de bonnes réponses pour réussir
  questions: [
    {
      id: "q1",
      question: "La ligne 1 « n, resultat : des entiers » correspond à :",
      code:
"Algorithme somme_pairs(n)\n" +
"1  n, resultat : des entiers\n" +
"2  début\n" +
"3    resultat ← 0\n" +
"4    tant que resultat < n faire\n" +
"5      resultat ← resultat + 2\n" +
"6    fin tq\n" +
"7    retourner resultat\n" +
"8  fin",
      options: [
        "La déclaration des variables",
        "L'initialisation des variables",
        "Une affectation",
        "Un test conditionnel"
      ],
      answer: 0,
      explain: "Déclarer une variable, c'est annoncer son nom et son type (ici n et resultat sont des entiers), sans encore lui donner de valeur."
    },
    {
      id: "q2",
      question: "Dans le même algorithme, la ligne 3 « resultat ← 0 » correspond à :",
      code:
"3    resultat ← 0\n" +
"4    tant que resultat < n faire\n" +
"5      resultat ← resultat + 2",
      options: [
        "La déclaration d'une variable",
        "L'initialisation de la variable (une affectation)",
        "Une boucle bornée",
        "Un test conditionnel"
      ],
      answer: 1,
      explain: "La flèche ← donne une valeur à la variable. Comme c'est sa toute première valeur, on parle d'initialisation ; techniquement c'est une affectation."
    },
    {
      id: "q3",
      question: "La ligne « tant que resultat < n faire » correspond à :",
      code: "tant que resultat < n faire\n    resultat ← resultat + 2\nfin tq",
      options: [
        "Une boucle bornée",
        "Une boucle non bornée",
        "Un test conditionnel simple",
        "Une affectation"
      ],
      answer: 1,
      explain: "« Tant que » répète tant qu'une condition reste vraie, sans connaître le nombre de tours à l'avance : c'est une boucle non bornée."
    },
    {
      id: "q4",
      question: "L'instruction « Pour i allant de 1 à N faire » est :",
      code: "Pour i allant de 1 à N faire\n    afficher(i)\nFin Pour",
      options: [
        "Une boucle bornée",
        "Une boucle non bornée",
        "Un test conditionnel",
        "Une fonction"
      ],
      answer: 0,
      explain: "« Pour » connaît d'avance le nombre de tours (de 1 à N) : c'est une boucle bornée."
    },
    {
      id: "q5",
      question: "On exécute cet algorithme avec nombre = 0. Que retourne-t-il ?",
      code:
"1  début\n" +
"2    si nombre < 0 alors\n" +
"3      retourner \"Le nombre est négatif\"\n" +
"4    sinon si nombre > 0 alors\n" +
"5      retourner \"Le nombre est positif\"\n" +
"6    sinon si nombre = 0 alors\n" +
"7      retourner \"Le nombre est nul\"\n" +
"8    sinon\n" +
"9      retourner \"Vous êtes sûr d'avoir entré un nombre ?\"\n" +
"10   fin si\n" +
"11  fin",
      options: [
        "« Le nombre est négatif »",
        "« Le nombre est positif »",
        "« Le nombre est nul »",
        "« Vous êtes sûr d'avoir entré un nombre ? »"
      ],
      answer: 2,
      explain: "nombre = 0 : la condition < 0 est fausse, la condition > 0 est fausse, la condition = 0 est vraie → on retourne « Le nombre est nul »."
    },
    {
      id: "q6",
      question: "Voici la recette : faire fondre le chocolat et le beurre puis mélanger ; ajouter sucre, œufs, farine puis mélanger ; beurrer et fariner le moule ; verser la pâte ; préchauffer le four à 180°C ; cuire 30 min. Quel algorithme la décrit correctement, sans rien oublier ni inverser ?",
      options: [
        "Fondre → Ajouter sucre/œufs/farine → Beurrer/fariner → Verser → Cuire",
        "Fondre → Mélanger → Ajouter → Mélanger → Beurrer/fariner le moule → Verser la pâte → Préchauffer le four à 180°C → Cuire 30 min",
        "Ajouter → Fondre → Mélanger → Verser → Cuire",
        "Fondre → Ajouter → Mélanger → Verser → Préchauffer → Cuire"
      ],
      answer: 1,
      explain: "Il faut respecter l'ordre ET garder toutes les étapes : les deux mélanges, la préparation du moule, le préchauffage, puis la cuisson."
    },
    {
      id: "q7",
      question: "On découpe la recette en deux sous-problèmes : « PâteAGâteau » (préparer la pâte) et « Cuisson ». Quel découpage est cohérent ?",
      options: [
        "PâteAGâteau : fondre → mélanger → ajouter → mélanger → verser la pâte dans le moule.  Cuisson : préchauffer le four à 180°C → enfourner le moule.",
        "PâteAGâteau : fondre → mélanger → ajouter.  Cuisson : mélanger → verser → préchauffer → enfourner.",
        "PâteAGâteau : fondre → mélanger → ajouter → verser → préchauffer.  Cuisson : enfourner.",
        "PâteAGâteau : préchauffer → enfourner.  Cuisson : fondre → mélanger → ajouter → verser."
      ],
      answer: 0,
      explain: "Un bon découpage regroupe les étapes cohérentes : toute la préparation de la pâte d'un côté (jusqu'à verser dans le moule), toute la cuisson de l'autre (préchauffer puis enfourner)."
    },
    {
      id: "q8",
      question: "Cet algorithme trie un tableau. De quel tri s'agit-il ?",
      code:
"Algorithme Tri(tableau)\n" +
"  N ← Taille du tableau\n" +
"  Pour i allant de 1 à N-1 :\n" +
"    x ← tableau[i]\n" +
"    j ← i\n" +
"    Tant que j > 0 ET tableau[j-1] > x :\n" +
"      tableau[j] ← tableau[j-1]\n" +
"      j ← j - 1\n" +
"    Fin Tant que\n" +
"    tableau[j] ← x\n" +
"  Fin Pour\n" +
"Fin",
      options: [
        "Tri par sélection",
        "Tri par insertion",
        "Tri à bulles",
        "Ce n'est pas un tri"
      ],
      answer: 1,
      explain: "On prend chaque élément (x) et on l'insère à sa place en décalant vers la droite les éléments plus grands : c'est le tri par insertion."
    },
    {
      id: "q9",
      question: "Et cet algorithme-ci, de quel tri s'agit-il ?",
      code:
"Algorithme Tri(tableau)\n" +
"  N ← Taille du tableau\n" +
"  Pour i allant de 0 à N-2 :\n" +
"    min ← i\n" +
"    Pour j allant de i+1 à N-1 :\n" +
"      Si tableau[j] < tableau[min] :\n" +
"        min ← j\n" +
"      Fin Si\n" +
"    Fin Pour\n" +
"    Si min ≠ i :\n" +
"      echanger(tableau[i], tableau[min])\n" +
"    Fin Si\n" +
"  Fin Pour\n" +
"Fin",
      options: [
        "Tri par sélection",
        "Tri par insertion",
        "Tri à bulles",
        "Une simple recherche du maximum"
      ],
      answer: 0,
      explain: "À chaque tour on cherche le plus petit élément du reste du tableau (min) et on le place à sa position : c'est le tri par sélection."
    },
    {
      id: "q10",
      question: "En Python, quelle instruction affiche le texte « Bonjour » à l'écran ?",
      options: [
        "print(\"Bonjour\")",
        "afficher(\"Bonjour\")",
        "echo \"Bonjour\"",
        "print = \"Bonjour\""
      ],
      answer: 0,
      explain: "En Python, on affiche à l'écran avec la fonction print(...)."
    },
    {
      id: "q11",
      question: "En Python, combien de fois s'exécute la boucle « for i in range(5): » ?",
      code: "for i in range(5):\n    print(i)",
      options: ["4 fois", "5 fois", "6 fois", "Une infinité de fois"],
      answer: 1,
      explain: "range(5) produit les valeurs 0, 1, 2, 3, 4 : la boucle tourne 5 fois."
    },
    {
      id: "q12",
      question: "En Python, que teste la condition « if x % 2 == 0 : » ?",
      options: [
        "Que x est négatif",
        "Que x est pair",
        "Que x est impair",
        "Que x est égal à 2"
      ],
      answer: 1,
      explain: "x % 2 est le reste de la division de x par 2. S'il vaut 0, alors x est pair."
    },
    {
      id: "q13",
      question: "On veut enregistrer la température de cuisson (180) et le temps de cuisson (30). Combien de variables faut-il, au minimum ?",
      options: ["1 variable", "2 variables", "3 variables", "Aucune variable"],
      answer: 1,
      explain: "Deux informations distinctes → deux variables : une pour la température, une pour le temps."
    },
    {
      id: "q14",
      question: "Pour échanger les valeurs de deux variables a et b, quelle méthode est correcte ?",
      options: [
        "a ← b   puis   b ← a",
        "temp ← a ;  a ← b ;  b ← temp",
        "a ← b ;  b ← temp",
        "b ← a   puis   a ← b"
      ],
      answer: 1,
      explain: "Sans variable temporaire, la première valeur est écrasée. On garde a dans temp, on met b dans a, puis l'ancien a (temp) dans b."
    },
    {
      id: "q15",
      question: "Dans la plupart des langages (dont Python), le premier élément d'un tableau t se trouve à l'indice :",
      options: ["1", "0", "-1", "Le premier élément n'a pas d'indice"],
      answer: 1,
      explain: "L'indexation commence à 0 : t[0] est le premier élément, t[1] le deuxième, etc."
    },
    {
      id: "q16",
      question: "La condition « (age ≥ 18) ET (age ≤ 25) » est vraie pour quelle valeur ?",
      options: ["age = 30", "age = 15", "age = 20", "age = 17"],
      answer: 2,
      explain: "Avec « ET », les deux conditions doivent être vraies en même temps : il faut un âge entre 18 et 25 inclus. Seul 20 convient."
    },
    {
      id: "q17",
      question: "À quoi sert de découper un programme en sous-programmes (fonctions) ?",
      options: [
        "À rendre le programme volontairement plus long",
        "À réutiliser du code et à le rendre plus clair",
        "À ralentir l'exécution",
        "À supprimer les variables"
      ],
      answer: 1,
      explain: "Une fonction regroupe une tâche qu'on peut nommer et réutiliser : le programme devient plus lisible et on évite de répéter le même code."
    },
    {
      id: "q18",
      question: "En Python, après « age = input(\"Ton âge ? \") », de quel type est la variable age ?",
      code: "age = input(\"Ton âge ? \")",
      options: [
        "Un entier (int)",
        "Une chaîne de caractères (str)",
        "Un booléen",
        "Un nombre décimal (float)"
      ],
      answer: 1,
      explain: "input() renvoie toujours une chaîne de caractères. Pour s'en servir comme nombre, il faut la convertir, par exemple int(age)."
    },
    {
      id: "q19",
      question: "Que vaut s à la fin de cet algorithme ?",
      code:
"s ← 0\n" +
"Pour i allant de 1 à 4 faire\n" +
"    s ← s + i\n" +
"Fin Pour",
      options: ["4", "10", "24", "0"],
      answer: 1,
      explain: "À chaque tour on ajoute i : 1 + 2 + 3 + 4 = 10."
    }
  ]
};

// Version publique : sans les réponses ni les explications (anti-triche).
function quizForClient(q) {
  return {
    id: q.id,
    title: q.title,
    intro: q.intro,
    passPct: Math.round(q.passRatio * 100),
    total: q.questions.length,
    questions: q.questions.map((it) => ({ id: it.id, question: it.question, code: it.code || null, options: it.options }))
  };
}

// Notation d'un lot de réponses { qId: index }.
function gradeQuiz(q, answers) {
  answers = answers || {};
  let score = 0;
  const details = q.questions.map((it) => {
    const given = answers[it.id];
    const ok = (given === it.answer);
    if (ok) score++;
    return { id: it.id, correct: it.answer, given: (typeof given === "number" ? given : null), ok, explain: it.explain };
  });
  const total = q.questions.length;
  const passed = (score / total) >= q.passRatio;
  return { score, total, passPct: Math.round(q.passRatio * 100), passed, details };
}

module.exports = { QUIZ_PROGRAMMATION, quizForClient, gradeQuiz };
