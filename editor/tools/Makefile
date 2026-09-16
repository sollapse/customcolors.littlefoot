# Builds the C++ tools for the editor: the program generator, the simulator and the profiler.
#
# Dependencies, neither of them vendored here:
#
#   BLOCKS SDK          https://github.com/WeAreROLI/BLOCKS-SDK          supplies JUCE's juce_core
#   roli_blocks_basics  https://github.com/WeAreROLI/roli_blocks_basics  the littlefoot compiler and runner
#
# Point the makefile at your checkouts, on the command line or in the environment. SDK is the SDK
# folder that holds juce_core, not the top of the repository:
#
#   make SDK=~/BLOCKS-SDK/SDK BLOCKS=~/roli_blocks_basics
#
# On Windows, build inside WSL: the tools are plain C++, but juce_core expects a POSIX system.
#
#   make          build lfgen, lfsim and lfprof into build/
#   make regen    rebuild ../editor_program.js from ../editor_program.littlefoot, with lfgen
#   make clean    remove build/

SDK    ?= $(HOME)/BLOCKS-SDK/SDK
BLOCKS ?= $(HOME)/roli_blocks_basics

BUILD    := build
NATIVES  := $(BUILD)/natives.inc
JUCE_OBJ := $(BUILD)/juce_core.o
PROTOCOL := $(BLOCKS)/protocol/roli_BlocksProtocolDefinitions.h
TOOLS    := $(BUILD)/lfgen $(BUILD)/lfsim $(BUILD)/lfprof

# Neither define is optional: juce_core refuses to compile without a module config header, and without
# JUCE_USE_CURL=0 the link fails on curl symbols that none of these tools ever reach.
CXXFLAGS ?= -std=c++17 -O2
DEFS     := -DJUCE_GLOBAL_MODULE_SETTINGS_INCLUDED=1 -DJUCE_USE_CURL=0
INCLUDES := -I$(SDK) -I$(BLOCKS)/littlefoot -I$(BUILD)

# On macOS juce_core is Objective-C++ and wants the system frameworks instead of the POSIX libraries
ifeq ($(shell uname),Darwin)
    JUCE_SRC := $(SDK)/juce_core/juce_core.mm
    LIBS     := -framework CoreFoundation -framework Foundation -framework IOKit -framework Security
else
    JUCE_SRC := $(SDK)/juce_core/juce_core.cpp
    LIBS     := -lpthread -ldl -lrt
endif

all: $(TOOLS)

$(BUILD):
	@mkdir -p $(BUILD)

# The compiler front end needs the SDK's own table of littlefoot functions, under the name the tools use.
# The header is CRLF, and rewriting its first line drops that line's carriage return, so strip them all
# and write one kind of line ending whatever the checkout looks like.
$(NATIVES): $(PROTOCOL) | $(BUILD)
	@test -f $(PROTOCOL) || { echo "not found: $(PROTOCOL)"; echo "set BLOCKS to your roli_blocks_basics checkout"; exit 1; }
	@sed -n '/ledProgramLittleFootFunctions\[\] =/,/^[[:space:]]*};/p' $(PROTOCOL) \
	    | tr -d '\r' \
	    | sed '1s/.*/static const char* const lfNatives[] =/' \
	    | sed '$$s/^[[:space:]]*};/};/' > $@
	@test -s $@ || { echo "could not read the function table out of $(PROTOCOL)"; rm -f $@; exit 1; }
	@echo "generated $@ from the SDK"

$(JUCE_OBJ): $(JUCE_SRC) | $(BUILD)
	@test -f $(JUCE_SRC) || { echo "not found: $(JUCE_SRC)"; echo "set SDK to the SDK folder holding juce_core"; exit 1; }
	$(CXX) $(CXXFLAGS) $(DEFS) -I$(SDK) -c $(JUCE_SRC) -o $@

$(BUILD)/%: %.cpp $(JUCE_OBJ) $(NATIVES)
	$(CXX) $(CXXFLAGS) $(DEFS) $(INCLUDES) $< $(JUCE_OBJ) -o $@ $(LIBS)

# lfgen writes the program the page uploads; the .bin stays in build/, the .js belongs to the repository
regen: $(BUILD)/lfgen
	$(BUILD)/lfgen ../editor_program.littlefoot ../editor_program.js $(BUILD)/editor_program.bin EDITOR_PROGRAM

clean:
	rm -rf $(BUILD)

.PHONY: all regen clean
