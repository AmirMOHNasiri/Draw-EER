# The `.eer` language

An `.eer` file describes one ER/EER diagram. Each declaration starts on its own line.
Names can be any Unicode word (Persian included) or a quoted string for names with spaces or
symbols: `"عضو خانواده"`, `"S#"`, `"سال-ترم"`.

Only **syntax** is checked. Nothing about the design itself is validated: if the file parses, it
is drawn.

## Entities and attributes

```
entity Employee {
  id: key                         // primary key: underlined
  ssn: key2                       // secondary key: double underline
  name { first, last }            // composite: braces, nested to any depth
  phones: multi                   // multi-valued: double ellipse
  age: derived                    // derived: dashed ellipse
  address: multi { city, street } // flags and braces combine
}

entity Course { (code, term): key }   // composite key: one line under all parts

weak entity Dependent {               // weak entity: double rectangle
  name: partial                       // partial key (discriminator): dashed underline
  birth_date
}

entity TA inherits Employee, Student { hours }   // subtype of one or more supertypes
```

| Flag      | Meaning                      | Drawn as               |
| --------- | ---------------------------- | ---------------------- |
| `key`     | primary key                  | underlined name        |
| `key2`    | secondary (alternate) key    | double-underlined name |
| `partial` | partial key of a weak entity | dashed underline       |
| `multi`   | multi-valued                 | double ellipse         |
| `derived` | derived (virtual)            | dashed ellipse         |

Key groups `( … ): key | key2 | partial` declare several attributes that form one key together.

Items inside `{ }` are separated by **new lines or commas**. One item stays on one line.

## Relationships

```
identifying rel Has {        // identifying relationship: double diamond
  Employee 1
  Dependent N total          // total participation: double line
}

rel Enroll {
  Student (1,N) total        // (min,max) notation
  Course (0,M)
  attrs { term, year }       // attributes of the relationship
}

rel Prerequisite {           // unary (recursive) with role labels
  Course N as "requires"
  Course M as "required_by"
}

rel Teaches { Professor, Course, Student }   // ternary, no cardinalities
```

A participant is an entity name followed by any of these, in any order:

- a cardinality: a number, a single letter or `*` (`1`, `N`, `M`, `ن`), or `(min,max)` such as
  `(0,N)` or `(1,*)`. It is drawn near the entity end of the line.
- `total` (double line) or `partial` (single line, the default)
- `as role`: a role label on the line

Names that are used but never declared become plain entities.

## Specialization, categories, part-of, aggregation

```
specialize Employee disjoint total { Secretary, Engineer }   // circle with D, double line
specialize Programmer overlapping { Frontend, Backend }      // circle with O
specialize Employee { Manager }                              // no d/o given: no circle

category Owner total { Person, Company, Bank }   // circle with U

partof Vehicle { Engine, Chassis }               // "Has" hexagon on each line
partof Vehicle as "Contains" { Wheel }           // custom label

aggregate Supervision { rel Guides { Professor, Student, Project } }
rel Evaluates { Supervision, Evaluator }         // connects to the dashed box
```

## Repeated entities

```
show Course again as Course2      // draws a second copy of Course
rel Prerequisite { Course N, Course2 M }
```

## Comments

`// to the end of the line` and `/* block */`.

## Grammar

```ebnf
file        = { statement } ;
statement   = entity | rel | specialize | category | partof | aggregate | show ;

entity      = [ "weak" ] "entity" NAME [ "inherits" NAME { "," NAME } ] [ attrBlock ] ;
attrBlock   = "{" [ attrItem { SEP attrItem } ] "}" ;
attrItem    = NAME [ ":" { attrFlag } ] [ attrBlock ]        (* braces = composite *)
            | "(" NAME { "," NAME } ")" ":" keyKind ;        (* composite key *)
attrFlag    = keyKind | "multi" | "derived" ;
keyKind     = "key" | "key2" | "partial" ;

rel         = [ "identifying" ] "rel" NAME "{" [ relItem { SEP relItem } ] "}" ;
relItem     = participant | "attrs" attrBlock ;
participant = NAME { cardinality | "total" | "partial" | "as" NAME } ;
cardinality = LABEL | "(" LABEL "," LABEL ")" ;
LABEL       = NUMBER | LETTER | "*" ;

specialize  = "specialize" NAME { "disjoint" | "overlapping" | "total" | "partial" }
              "{" NAME { SEP NAME } "}" ;
category    = "category" NAME [ "total" | "partial" ] "{" NAME { SEP NAME } "}" ;
partof      = "partof" NAME [ "as" NAME ] "{" NAME { SEP NAME } "}" ;
aggregate   = "aggregate" NAME "{" rel "}" ;
show        = "show" NAME "again" [ "as" NAME ] ;

NAME        = IDENT | STRING ;
IDENT       = ( letter | "_" ) { letter | mark | digit | "_" | ZWNJ | ZWJ } ;
SEP         = newline | "," ;
```

Keywords are contextual: they only act as keywords where the grammar expects them, so words like
`key` or `total` still work as names. A quoted name is never a keyword. Each modifier may appear at
most once per item.
